#!/usr/bin/env python3
"""Independent evidence scorer: retrieval diagnostics, never answer accuracy."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import random
import statistics

from retrieval_common import (canonical, context, digest, file_hash, read_jsonl,
                              scope_split, validate_corpora, validate_queries,
                              write_json, write_jsonl)

METRICS = ['evidence_any_hit', 'evidence_all_hit', 'evidence_recall',
           'resolved_any_hit', 'resolved_all_hit', 'resolved_recall']


def evidence_scores(evidence, retrieved, available):
    if not isinstance(evidence, list):
        raise ValueError('evidence_ids must be a list; do not silently repair released labels')
    # Preserve every distinct literal JSON reference; malformed values never match.
    refs = {canonical(value): value for value in evidence}
    resolved = [v for v in refs.values() if isinstance(v, str) and v in available]
    hit = sum(v in retrieved for v in resolved)
    unresolved = [v for v in refs.values() if not isinstance(v, str) or v not in available]
    total, valid = len(refs), len(resolved)
    return {'evidence_ids_original': evidence, 'unresolved_evidence_ids': unresolved,
        'evidence_references': total, 'resolved_references': valid, 'evidence_hits': hit,
        'duplicate_evidence_references': len(evidence) - total,
        'evidence_any_hit': float(hit > 0) if total else None,
        'evidence_all_hit': float(hit == total) if total else None,
        'evidence_recall': hit / total if total else None,
        'resolved_any_hit': float(hit > 0) if valid else None,
        'resolved_all_hit': float(hit == valid) if valid else None,
        'resolved_recall': hit / valid if valid else None}


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def clustered_mean(rows, metric, samples, seed):
    clusters = defaultdict(lambda: [0.0, 0])
    for row in rows:
        # Include all scopes in the resampling frame, even all-N/A ones.
        aggregate = clusters[row['scope']]
        if row[metric] is not None:
            aggregate[0] += row[metric]
            aggregate[1] += 1
    values = [clusters[scope] for scope in sorted(clusters)]
    denominator = sum(n for _, n in values)
    point = sum(value for value, _ in values) / denominator if denominator else None
    randomizer = random.Random(seed)
    draws = []
    if denominator and values:
        for _ in range(samples):
            selected = [values[randomizer.randrange(len(values))] for _ in values]
            n = sum(count for _, count in selected)
            if n:
                draws.append(sum(total for total, _ in selected) / n)
    return {'mean': point, 'denominator_queries': denominator,
            'scope_count': len(values), 'eligible_scope_count': sum(n > 0 for _, n in values),
            'ci95_scope_cluster_bootstrap': [percentile(draws, .025), percentile(draws, .975)],
            'valid_bootstrap_draws': len(draws),
            'ci_warning': 'few_scopes_exploratory' if len(values) < 20 else None}


def describe(values):
    return {'count': len(values), 'mean': statistics.fmean(values) if values else None,
            'p50': percentile(values, .5), 'p95': percentile(values, .95),
            'p99': percentile(values, .99)}


def summarize(rows, samples, seed):
    return {'queries': len(rows), 'errors': sum(row['error'] is not None for row in rows),
        'empty_retrievals': sum(not row['retrieved_ids'] for row in rows),
        'no_evidence_queries': sum(row['evidence_references'] == 0 for row in rows),
        'unresolved_evidence_queries': sum(bool(row['unresolved_evidence_ids']) for row in rows),
        'evidence_references': sum(row['evidence_references'] for row in rows),
        'resolved_references': sum(row['resolved_references'] for row in rows),
        'duplicate_evidence_references': sum(row['duplicate_evidence_references'] for row in rows),
        'metrics': {metric: clustered_mean(rows, metric, samples, seed) for metric in METRICS},
        'context_bytes': describe([row['context_bytes'] for row in rows]),
        'retrieval_assembly_ms_observed': describe([row['retrieval_assembly_ms'] for row in rows
                                                   if row['retrieval_assembly_ms'] is not None]),
        'fully_resolved_queries': sum(row['evidence_references'] > 0 and
                                      not row['unresolved_evidence_ids'] for row in rows)}


def score(run_dir, corpora_path, queries_path, gold_path, output, samples=2000, seed=42):
    if samples < 1:
        raise ValueError('bootstrap-samples must be positive')
    if output.exists():
        raise ValueError('output exists; choose a fresh directory')
    manifest = json.loads((run_dir / 'manifest.json').read_text())
    config = manifest['config']
    if digest(canonical(config).encode()) != manifest['config_sha256']:
        raise ValueError('manifest configuration hash mismatch')
    if config['corpora_sha256'] != file_hash(corpora_path) or config['queries_sha256'] != file_hash(queries_path):
        raise ValueError('input hash mismatch: scorer must use exact runner inputs')
    corpora = validate_corpora(read_jsonl(corpora_path))
    queries = validate_queries(read_jsonl(queries_path), corpora)
    assignments = scope_split(corpora, config['seed'], config['dev_scopes'])
    if assignments != config['scope_assignments']:
        raise ValueError('scope split changed')
    queries = [q for q in queries if config['split'] == 'all' or assignments[q['scope']] == config['split']]
    if [q['id'] for q in queries] != manifest['query_ids']:
        raise ValueError('query denominator changed')
    methods = config['methods']
    if methods != ['no_memory', 'raw_full', 'raw_budget_recency', 'bm25_raw']:
        raise ValueError('unexpected methods')
    query_map = {q['id']: q for q in queries}
    lookup = {}
    document_maps = {s: {d['id']: d for d in docs} for s, docs in corpora.items()}
    for row in read_jsonl(run_dir / 'retrieval.jsonl'):
        key = (row['id'], row['method'])
        if key in lookup or row['id'] not in query_map or row['method'] not in methods:
            raise ValueError('duplicate or unexpected query/method row')
        query = query_map[row['id']]
        if (row['scope'] != query['scope'] or row['split'] != assignments[query['scope']]
                or row['config_sha256'] != manifest['config_sha256']):
            raise ValueError('trace scope/config mismatch')
        ids = row['retrieved_ids']
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
            raise ValueError('duplicate or invalid retrieved IDs')
        try:
            payload = context([document_maps[row['scope']][i] for i in ids])
        except KeyError as exc:
            raise ValueError('retrieved ID outside query scope') from exc
        if len(payload) != row['context_bytes'] or digest(payload) != row['context_sha256']:
            raise ValueError('trace context hash/bytes mismatch')
        if row['method'] != 'raw_full' and len(payload) > config['budget_bytes']:
            raise ValueError('matched budget violated')
        if row['method'] == 'no_memory' and ids:
            raise ValueError('no_memory contains context')
        if row['error'] is not None and ids:
            raise ValueError('failed retrieval cannot receive partial-success credit')
        lookup[key] = row
    gold = {}
    for label in read_jsonl(gold_path):
        if not isinstance(label, dict) or not isinstance(label.get('id'), str) or label['id'] in gold:
            raise ValueError('invalid or duplicate gold ID')
        if not isinstance(label.get('evidence_ids'), list):
            raise ValueError('evidence_ids must be a list; malformed evidence container')
        if label.get('category') is not None and not isinstance(label['category'], str):
            raise ValueError('category must be string or null')
        gold[label['id']] = label
    if not set(query_map) <= set(gold):
        raise ValueError('missing gold labels; refusing denominator loss')
    rows = []
    for query in queries:
        label = gold[query['id']]
        for method in methods:
            row = lookup.get((query['id'], method))
            if row is None:
                row = {'id': query['id'], 'scope': query['scope'], 'split': assignments[query['scope']],
                    'method': method, 'retrieved_ids': [], 'context_bytes': 0,
                    'retrieval_assembly_ms': None, 'error': {'type': 'missing_trace'}}
            row = dict(row)
            row['category'] = label.get('category')
            row.update(evidence_scores(label['evidence_ids'], set(row['retrieved_ids']),
                                       document_maps[query['scope']]))
            rows.append(row)
    # No answer text appears in output. Per-query evidence diagnostics still stay private.
    cohorts = {}
    split_names = ['all', 'dev', 'test'] if config['split'] == 'all' else [config['split']]
    categories = sorted({r['category'] for r in rows if r['category'] is not None})
    for split_name in split_names:
        split_rows = [r for r in rows if split_name == 'all' or r['split'] == split_name]
        category_groups = [('all_categories', split_rows)] + [
            ('category:' + category, [r for r in split_rows if r['category'] == category]) for category in categories]
        for category_name, subset in category_groups:
            if not subset:
                continue
            result = {'methods': {}, 'paired_differences_vs_raw_budget_recency': {}}
            for method in methods:
                method_rows = [r for r in subset if r['method'] == method]
                result['methods'][method] = summarize(method_rows, samples, seed)
                result['methods'][method]['raw_no_budget_unfair'] = method == 'raw_full'
            baseline = {r['id']: r for r in subset if r['method'] == 'raw_budget_recency'}
            for method in methods:
                if method == 'raw_budget_recency':
                    continue
                differences = []
                for row in subset:
                    if row['method'] != method:
                        continue
                    base = baseline[row['id']]
                    difference = {'scope': row['scope']}
                    for metric in METRICS:
                        if (row[metric] is None) != (base[metric] is None):
                            raise ValueError('paired metric denominator mismatch')
                        difference[metric] = None if row[metric] is None else row[metric] - base[metric]
                    differences.append(difference)
                result['paired_differences_vs_raw_budget_recency'][method] = {
                    'direction': 'method_minus_raw_budget_recency',
                    'raw_no_budget_unfair': method == 'raw_full',
                    'metrics': {metric: clustered_mean(differences, metric, samples, seed) for metric in METRICS}}
            cohorts[split_name + '/' + category_name] = result
    index_rows = read_jsonl(run_dir / 'index.jsonl')
    summary = {'schema_version': 1, 'quality_scope': 'retrieval_diagnostic_not_answer_quality',
        'config_sha256': manifest['config_sha256'], 'run_config': config,
        'scorer_sha256': file_hash(Path(__file__)), 'gold_sha256': file_hash(gold_path),
        'retrieval_trace_sha256': file_hash(run_dir / 'retrieval.jsonl'),
        'bootstrap': {'unit': 'scope', 'samples': samples, 'seed': seed,
            'estimand': 'query-weighted mean; resample scopes with replacement',
            'confidence': .95, 'method': 'percentile',
            'warning': 'Few scopes; descriptive exploratory CIs, not evidence of answer-quality noninferiority'},
        'evidence_policy': 'distinct original literal references; unresolved count as misses; no repair; '
            'empty evidence is N/A; resolved_* uses only resolvable references and has separate denominators',
        'index': {'scope_count': len(index_rows),
                  'build_ms': describe([r['index_build_ms'] for r in index_rows]),
                  'total_build_ms': sum(r['index_build_ms'] for r in index_rows),
                  'total_size_proxy_bytes': sum(r['index_size_proxy_bytes'] for r in index_rows),
                  'size_proxy_definition': 'canonical JSON postings/lengths/average, not RSS'},
        'input_tokens': None, 'output_tokens': None, 'cost': None,
        'generation_ms': None, 'end_to_end_generation_ms': None, 'answer_quality': None,
        'cohorts': cohorts}
    output.mkdir(parents=True, exist_ok=False)
    write_jsonl(output / 'scores.private.jsonl', rows)
    write_json(output / 'summary.json', summary)
    return {'queries': len(queries), 'scored_rows': len(rows), 'cohorts': len(cohorts),
            'summary': str(output / 'summary.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['run', 'corpora', 'queries', 'gold', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--bootstrap-samples', type=int, default=2000)
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    print(canonical(score(args.run, args.corpora, args.queries, args.gold, args.output,
                          args.bootstrap_samples, args.seed)))


if __name__ == '__main__':
    main()
