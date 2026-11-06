#!/usr/bin/env python3
"""Reconstruct verified retrieval contexts for a separate reader; no model calls."""
import argparse
import json
from pathlib import Path

from retrieval_common import (canonical, context, digest, file_hash, read_jsonl,
                              scope_split, validate_corpora, validate_queries,
                              write_json, write_jsonl)


def export(run_dir, corpora_path, queries_path, output, method, split, limit):
    manifest_path = output.with_name(output.name + '.manifest.json')
    if output.exists() or manifest_path.exists():
        raise ValueError('output or associated manifest exists; use a fresh output path')
    if limit < 0 or split not in {'all', 'dev', 'test'}:
        raise ValueError('invalid limit/split')
    manifest = json.loads((run_dir / 'manifest.json').read_text())
    config = manifest['config']
    if digest(canonical(config).encode()) != manifest['config_sha256']:
        raise ValueError('configuration hash mismatch')
    if method not in config['methods']:
        raise ValueError('method not present in run')
    if file_hash(corpora_path) != config['corpora_sha256'] or file_hash(queries_path) != config['queries_sha256']:
        raise ValueError('input hash mismatch')
    corpora = validate_corpora(read_jsonl(corpora_path))
    queries = validate_queries(read_jsonl(queries_path), corpora)
    assignments = scope_split(corpora, config['seed'], config['dev_scopes'])
    if assignments != config['scope_assignments']:
        raise ValueError('scope split changed')
    run_queries = [q for q in queries if config['split'] == 'all' or assignments[q['scope']] == config['split']]
    if manifest['query_ids'] != [q['id'] for q in run_queries]:
        raise ValueError('query denominator changed')
    if config['split'] != 'all' and split not in {'all', config['split']}:
        raise ValueError('requested split absent from run')
    selected = [q for q in run_queries if split == 'all' or assignments[q['scope']] == split]
    eligible_count = len(selected)
    if limit:
        selected = selected[:limit]
    traces = {}
    for row in read_jsonl(run_dir / 'retrieval.jsonl'):
        if row['method'] != method:
            continue
        if row['id'] in traces:
            raise ValueError('duplicate trace for method')
        traces[row['id']] = row
    documents = {s: {d['id']: d for d in docs} for s, docs in corpora.items()}
    result = []
    for query in selected:
        row = traces.get(query['id'])
        if row is None or row['error'] is not None:
            raise ValueError('missing/failed retrieval: refusing to silently omit a query')
        if (row['scope'] != query['scope'] or row['split'] != assignments[query['scope']]
                or row['config_sha256'] != manifest['config_sha256']):
            raise ValueError('trace scope/config mismatch')
        ids = row['retrieved_ids']
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
            raise ValueError('invalid/duplicate retrieved IDs')
        payload = context([documents[query['scope']][i] for i in ids])
        if len(payload) != row['context_bytes'] or digest(payload) != row['context_sha256']:
            raise ValueError('context hash/bytes mismatch')
        if method != 'raw_full' and len(payload) > config['budget_bytes']:
            raise ValueError('matched budget violated')
        if method == 'no_memory' and ids:
            raise ValueError('no_memory contains context')
        result.append({'id': query['id'], 'query': query['question'], 'context': payload.decode('utf-8')})
    output.parent.mkdir(parents=True, exist_ok=True)
    write_jsonl(output, result)
    metadata = {'schema_version': 1, 'config_sha256': manifest['config_sha256'],
        'method': method, 'split': split, 'limit': limit, 'eligible_queries': eligible_count,
        'exported_queries': len(result), 'query_ids': [r['id'] for r in result],
        'scope_assignments': {q['scope']: assignments[q['scope']] for q in selected},
        'output_sha256': file_hash(output), 'trace_sha256': file_hash(run_dir / 'retrieval.jsonl'),
        'exporter_sha256': file_hash(Path(__file__)), 'gold_loaded': False, 'model_calls': 0,
        'raw_no_budget_unfair': method == 'raw_full',
        'budget_bytes': None if method == 'raw_full' else config['budget_bytes'],
        'adapter_contract': 'JSONL with exactly id/query/context; no gold or category fields',
        'limitation': 'question date is not injected: adapter input query is the original question text'}
    write_json(manifest_path, metadata)
    return {'exported_queries': len(result), 'output': str(output), 'manifest': str(manifest_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['run', 'corpora', 'queries', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--method', choices=['no_memory', 'raw_full', 'raw_budget_recency', 'bm25_raw'], required=True)
    parser.add_argument('--split', choices=['all', 'dev', 'test'], required=True)
    parser.add_argument('--limit', type=int, required=True, help='Explicit selection: 0 means all eligible queries')
    args = parser.parse_args()
    print(canonical(export(args.run, args.corpora, args.queries, args.output,
                           args.method, args.split, args.limit)))


if __name__ == '__main__':
    main()
