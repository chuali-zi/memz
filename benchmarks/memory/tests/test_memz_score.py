"""Synthetic evaluator contract tests, no service/model required."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from memz_score import canonical, digest, score


def seal(body):
    return {**body, "sha256": digest(canonical(body).encode())}


def fixture():
    prepared = seal({"kind": "memz-history-v1", "scope": "s1", "documents": [
        {"id": "D1", "session_id": "S1", "date": None, "text": "Synthetic blue source."}]})
    source = {"id": 1, "title": "memz history D1", "content": "Synthetic blue source."}
    ingested = seal({"kind": "memz-ingested-v1", "prepared": prepared,
                     "binding": {"baseURL": "http://127.0.0.1:3000", "projectId": 1},
                     "sources": [{"documentId": "D1", "sourceId": 1, "sourceSha256": digest(canonical(source).encode())}]})
    fact = {"id": 1, "subject": "color", "predicate": "status", "value": "blue", "version": 1,
            "revisionId": 1, "candidateId": 1, "proposedBy": 2, "approvedBy": 1, "source": source}
    frozen = seal({"kind": "memz-frozen-v1", "ingested": ingested, "readerPrincipal": "viewer",
                   "snapshot": {"facts": [fact], "sources": [source]}})
    q = {"id": "q1", "scope": "s1", "question": "color"}
    context = canonical({"sourceTextIsUntrusted": True, "facts": [
        {**fact, "source": {**source, "documentId": "D1", "sessionId": "S1", "date": None}}]})
    rows = []
    for method in ["memz_current", "flat_same_facts"]:
        rows.append({"id": "q1", "method": method, "status": "context_ready_no_generation", "scope": "s1",
                     "frozenSha256": frozen["sha256"], "querySha256": digest(canonical(q).encode()),
                     "context": context, "contextBytes": len(context.encode()), "contextSha256": digest(context.encode()),
                     "readerInput": {"id": f"q1:{method}", "query": "color", "context": context},
                     "retrievedDocumentIds": ["D1"], "provenance": [
                         {k: fact[k] for k in ["id", "version", "revisionId", "candidateId", "approvedBy", "proposedBy"]}
                         | {"sourceId": 1}]})
    return {"frozen": frozen, "queries": [q]}, rows, [{"id": "q1", "evidence_ids": ["D1"], "answer": "GOLD_SENTINEL"}]


class MemzScoreTests(unittest.TestCase):
    def test_gold_is_evaluator_only_and_never_claims_answer_accuracy(self):
        batch, rows, gold = fixture()
        result = score(batch, rows, gold)
        self.assertEqual(result["summary"]["memz_current"]["evidence_recall"], 1)
        self.assertIsNone(result["summary"]["memz_current"]["answer_accuracy"])
        self.assertNotIn("GOLD_SENTINEL", json.dumps(result))
        self.assertNotIn("GOLD_SENTINEL", json.dumps(batch) + json.dumps(rows))

    def test_missing_and_failed_rows_keep_full_denominator(self):
        batch, rows, gold = fixture()
        missing = score(batch, rows[:1], gold)
        self.assertEqual(missing["summary"]["flat_same_facts"], {"queries": 1, "failures": 1, "evidence_recall": 0,
                                                                    "evidence_denominator": 1, "answer_accuracy": None})
        failed = [{"id": "q1", "method": "memz_current", "status": "error", "context": None}]
        self.assertEqual(score(batch, failed, gold)["summary"]["memz_current"]["evidence_recall"], 0)

    def test_tampered_provenance_context_query_or_scope_is_rejected(self):
        for field, value in [("context", "changed"), ("querySha256", "bad"), ("scope", "s2"),
                             ("retrievedDocumentIds", ["unrelated"]), ("provenance", [])]:
            batch, rows, gold = fixture();rows[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                score(batch, rows, gold)
        batch, rows, gold = fixture();batch["frozen"]["snapshot"]["facts"][0]["value"] = "tampered"
        with self.assertRaises(ValueError):
            score(batch, rows, gold)

    def test_empty_and_unresolved_evidence_are_not_repaired(self):
        batch, rows, gold = fixture();gold[0]["evidence_ids"] = []
        self.assertIsNone(score(batch, rows, gold)["summary"]["memz_current"]["evidence_recall"])
        gold[0]["evidence_ids"] = ["D1", "D1", " D1", {"bad": True}]
        self.assertAlmostEqual(score(batch, rows, gold)["summary"]["memz_current"]["evidence_recall"], 1 / 3)

    def test_duplicate_rows_and_missing_gold_are_not_silently_dropped(self):
        batch, rows, gold = fixture()
        for bad_rows, bad_gold in [(rows + [copy.deepcopy(rows[0])], gold), (rows, []), (rows, gold + gold)]:
            with self.assertRaises(ValueError):
                score(batch, bad_rows, bad_gold)


if __name__ == "__main__":
    unittest.main()
