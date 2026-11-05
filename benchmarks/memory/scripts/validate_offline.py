#!/usr/bin/env python3
"""Check real LoCoMo normalization, label separation, scope and trace integrity."""
from collections import Counter
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT / 'data/locomo/locomo10.json')
    parser.add_argument('--prepared', type=Path, default=ROOT / 'prepared/locomo')
    parser.add_argument('--trace', type=Path, default=ROOT / 'reports/locomo-offline-all.jsonl')
    parser.add_argument('--output', type=Path, default=ROOT / 'reports/offline-validation.json')
    args = parser.parse_args()
    raw = json.loads(args.input.read_text(encoding='utf-8'))
    def load(name):
        return [json.loads(s) for s in (args.prepared / name).read_text(encoding='utf-8').splitlines()]
    corpora, queries, gold = map(load, ['corpora.jsonl', 'queries.jsonl', 'gold.private.jsonl'])
    assert len(corpora) == len(raw) == 10
    assert len(queries) == len(gold) == sum(len(s['qa']) for s in raw) == 1986
    assert len({q['id'] for q in queries}) == len(queries)
    assert {q['id'] for q in queries} == {g['id'] for g in gold}
    assert all(set(q) <= {'id', 'scope', 'question', 'date'} for q in queries)
    assert all(set(d) == {'id', 'date', 'session_id', 'text'}
               for c in corpora for d in c['documents'])
    by_scope = {c['scope']: {d['id'] for d in c['documents']} for c in corpora}
    by_query = {q['id']: q for q in queries}
    traces = [json.loads(s) for s in args.trace.read_text(encoding='utf-8').splitlines()]
    assert len(traces) == len(queries)
    assert {t['id'] for t in traces} == set(by_query)
    assert all(set(t['retrieved_ids']) <= by_scope[t['scope']] for t in traces)
    assert all(t['answer_quality'] is None and t['input_tokens'] is None
               and t['output_tokens'] is None for t in traces)
    missing = []
    for label in gold:
        scope = by_query[label['id']]['scope']
        for evidence in label['evidence_ids']:
            if evidence not in by_scope[scope]:
                missing.append({'question_id': label['id'], 'evidence_id': evidence})
    report = {
        'status': 'pipeline_passed_label_anomalies_preserved' if missing else 'passed',
        'source_conversations': len(raw), 'source_questions': sum(len(s['qa']) for s in raw),
        'normalized_questions': len(queries), 'trace_rows': len(traces),
        'turns': sum(len(c['documents']) for c in corpora),
        'duplicate_query_ids': 0, 'label_keys_in_public_query_or_document': 0,
        'retrieved_ids_outside_scope': 0,
        'unresolved_official_evidence_references': missing,
        'unresolved_official_evidence_references_count': len(missing),
        'category_counts': dict(Counter(g['category'] for g in gold)),
        'model_calls': 0, 'memz_runs': 0,
        'note': 'No answer-quality evaluation or latency comparison performed; labels retained, not repaired.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items()
                      if k != 'unresolved_official_evidence_references'}, indent=2))


if __name__ == '__main__':
    main()
