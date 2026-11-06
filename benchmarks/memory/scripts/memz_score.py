#!/usr/bin/env python3
"""Independent evaluator for frozen memz retrieval traces, not answer accuracy.

Only this stage receives gold. It makes no HTTP/model calls and never writes back
to the memory or reader. Missing/error rows remain in the paired denominator.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

from retrieval_common import canonical, digest, validate_corpora, validate_queries
from retrieval_score import evidence_scores

METHODS = ("memz_current", "flat_same_facts")


def verify_artifact(value, kind):
    body = {k: v for k, v in value.items() if k != "sha256"}
    if body.get("kind") != kind or digest(canonical(body).encode()) != value.get("sha256"):
        raise ValueError("artifact hash/kind mismatch")
    return body


def score(batch, rows, gold):
    if set(batch) != {"frozen", "queries"}:
        raise ValueError("invalid batch")
    frozen = verify_artifact(batch["frozen"], "memz-frozen-v1")
    ingested = verify_artifact(frozen["ingested"], "memz-ingested-v1")
    prepared = verify_artifact(ingested["prepared"], "memz-history-v1")
    scope = prepared["scope"]
    corpora = validate_corpora([{"scope": scope, "documents": prepared["documents"]}])
    queries = validate_queries(batch["queries"], corpora)
    if not queries or len(queries) > 20:
        raise ValueError("invalid query count")
    labels = {}
    for label in gold:
        if label["id"] in labels:
            raise ValueError("duplicate gold ID")
        labels[label["id"]] = label
    available = {d["id"] for d in prepared["documents"]}
    documents = {d["id"]: d for d in prepared["documents"]}
    source_map = {s["sourceId"]: s["documentId"] for s in ingested["sources"]}
    approved = {f["id"]: f for f in frozen["snapshot"]["facts"]}
    query_ids = {q["id"] for q in queries}
    traces = {}
    for row in rows:
        key = (row["id"], row["method"])
        if key in traces or row["id"] not in query_ids or row["method"] not in METHODS:
            raise ValueError("duplicate or out-of-scope trace")
        traces[key] = row
    scores = []
    for query in queries:
        if query["id"] not in labels:
            raise ValueError("missing gold ID")
        for method in METHODS:
            row = traces.get((query["id"], method))
            retrieved, failure = [], "missing_trace" if row is None else None
            if row is not None and row["status"] == "error":
                if row.get("context") is not None or row.get("retrievedDocumentIds") or row.get("provenance"):
                    raise ValueError("failed row contains retrieval output")
                failure = "adapter_error"
            elif row is not None:
                if (row["status"] != "context_ready_no_generation" or row.get("scope") != scope
                        or row.get("frozenSha256") != batch["frozen"]["sha256"]
                        or row.get("querySha256") != digest(canonical(query).encode())):
                    raise ValueError("trace binding mismatch")
                payload = row["context"].encode()
                if len(payload) != row["contextBytes"] or hashlib.sha256(payload).hexdigest() != row["contextSha256"]:
                    raise ValueError("context bytes/hash mismatch")
                context = json.loads(payload)
                if set(context) != {"sourceTextIsUntrusted", "facts"} or context["sourceTextIsUntrusted"] is not True:
                    raise ValueError("invalid context")
                seen, provenance = set(), []
                for fact in context["facts"]:
                    base = approved.get(fact["id"])
                    if base is None or fact["id"] in seen:
                        raise ValueError("unknown/duplicate approved fact")
                    seen.add(fact["id"])
                    document_id = source_map[base["source"]["id"]]
                    doc = documents[document_id]
                    expected = {**base, "source": {**base["source"], "documentId": document_id,
                                                   "sessionId": doc["session_id"], "date": doc["date"]}}
                    if fact != expected:
                        raise ValueError("fact/source/provenance mismatch")
                    if document_id not in retrieved:
                        retrieved.append(document_id)
                    provenance.append({k: base[k] for k in ("id", "version", "revisionId", "candidateId", "approvedBy", "proposedBy")}
                                      | {"sourceId": base["source"]["id"]})
                if retrieved != row["retrievedDocumentIds"] or provenance != row["provenance"]:
                    raise ValueError("retrieval trace mismatch")
                rendered_query = f'Question date: {query["date"]}\n{query["question"]}' if query.get("date") else query["question"]
                if row["readerInput"] != {"id": f'{query["id"]}:{method}', "query": rendered_query, "context": row["context"]}:
                    raise ValueError("reader input mismatch")
            metric = evidence_scores(labels[query["id"]]["evidence_ids"], retrieved, available)
            scores.append({"id": query["id"], "scope": scope, "method": method, "failure": failure, **metric})
    summary = {}
    for method in METHODS:
        group = [r for r in scores if r["method"] == method]
        eligible = [r["evidence_recall"] for r in group if r["evidence_recall"] is not None]
        summary[method] = {"queries": len(group), "failures": sum(r["failure"] is not None for r in group),
                           "evidence_recall": sum(eligible) / len(eligible) if eligible else None,
                           "evidence_denominator": len(eligible), "answer_accuracy": None}
    return {"scope": scope, "summary": summary, "scores": scores, "quality_scope": "retrieval_only_not_answer_quality",
            "model_calls": 0, "gold_used_only_by_evaluator": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("batch", "rows", "gold", "output"):
        parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args()
    for path in (args.batch, args.rows, args.gold):
        if path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("input file too large")
    result = score(json.loads(args.batch.read_text()), json.loads(args.rows.read_text()),
                   [json.loads(line) for line in args.gold.read_text().splitlines() if line.strip()])
    with open(args.output, "x", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
