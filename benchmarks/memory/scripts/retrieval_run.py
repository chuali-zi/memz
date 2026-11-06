#!/usr/bin/env python3
"""Offline retrieval diagnostics only. Never opens gold; never generates answers."""
import argparse
from collections import Counter
import math
from pathlib import Path
import platform
import random
import re
import time

from retrieval_common import (canonical, context, digest, file_hash, read_jsonl,
                              scope_split, validate_corpora, validate_queries,
                              write_json, write_jsonl)

METHODS = ['no_memory', 'raw_full', 'raw_budget_recency', 'bm25_raw']


def words(text):
    return re.findall(r'\w+', text.lower())


class BM25:
    """Own lexical implementation, k1=1.5 b=.75; not an official reproduction."""
    def __init__(self, documents):
        self.frequencies = [Counter(words(d['text'])) for d in documents]
        self.lengths = [sum(f.values()) for f in self.frequencies]
        self.avg = sum(self.lengths) / len(documents) if documents else 0
        self.postings = {}
        for i, frequency in enumerate(self.frequencies):
            for term, tf in frequency.items():
                self.postings.setdefault(term, []).append((i, tf))

    def rank(self, question):
        scores = {}
        n = len(self.lengths)
        for term in sorted(set(words(question))):
            postings = self.postings.get(term, [])
            df = len(postings)
            idf = math.log(1 + (n - df + .5) / (df + .5))
            for i, tf in postings:
                scores[i] = scores.get(i, 0) + idf * tf * 2.5 / (
                    tf + 1.5 * (.25 + .75 * self.lengths[i] / (self.avg or 1)))
        return sorted(scores, key=lambda i: (-scores[i], i))

    def snapshot(self):
        return {'postings': self.postings, 'lengths': self.lengths, 'avg': self.avg}


def select(documents, order, budget):
    """Greedy whole-unit packing; skip oversized candidates, never slice text."""
    selected, used, skipped = [], 0, []
    for i in order:
        size = len(context([documents[i]])) + (2 if selected else 0)
        if used + size <= budget:
            selected.append(documents[i])
            used += size
        else:
            skipped.append(documents[i]['id'])
    return selected, skipped


def run(corpora_path, queries_path, output, budget=8192, seed=42, dev_scopes=2, split='all'):
    if budget < 0 or split not in {'dev', 'test', 'all'}:
        raise ValueError('invalid budget or split')
    if output.exists():
        raise ValueError('output exists; choose a fresh directory')
    corpora = validate_corpora(read_jsonl(corpora_path))
    assignments = scope_split(corpora, seed, dev_scopes)
    chosen = {s: d for s, d in corpora.items() if split == 'all' or assignments[s] == split}
    indexes, index_rows = {}, []
    # Freeze every index before even reading query text.
    for scope, documents in chosen.items():
        start = time.perf_counter_ns()
        index = BM25(documents)
        elapsed = (time.perf_counter_ns() - start) / 1e6
        indexes[scope] = index
        snapshot = canonical(index.snapshot()).encode()
        corpus_bytes = canonical(documents).encode()
        index_rows.append({'scope': scope, 'split': assignments[scope], 'method': 'bm25_raw',
            'documents': len(documents), 'index_build_ms': elapsed,
            'index_size_proxy_bytes': len(snapshot), 'index_sha256': digest(snapshot),
            'corpus_serialized_bytes': len(corpus_bytes), 'corpus_sha256': digest(corpus_bytes),
            'size_proxy_definition': 'canonical JSON postings/lengths/average; not RSS or disk DB size'})
    queries = validate_queries(read_jsonl(queries_path), corpora)
    queries = [q for q in queries if q['scope'] in chosen]
    config = {'schema_version': 1, 'methods': METHODS, 'budget_bytes': budget,
        'budget_unit': 'serialized_context_utf8_bytes', 'seed': seed, 'dev_scopes': dev_scopes,
        'split': split, 'scope_assignments': assignments, 'packing': 'greedy_skip_whole_documents',
        'serialization': '[id] session=session_id date=date\\ntext; joined by two newlines',
        'bm25': {'k1': 1.5, 'b': .75, 'tokenizer': 'python_unicode_lower_regex_w_plus',
                 'query_tf': 'unique_terms', 'tie_break': 'original_corpus_order',
                 'zero_score': 'excluded', 'implementation': 'own_not_official'},
        'corpora_sha256': file_hash(corpora_path), 'queries_sha256': file_hash(queries_path),
        'code_sha256': {name: file_hash(Path(__file__).with_name(name)) for name in
                        ['retrieval_common.py', 'retrieval_run.py']}}
    config_hash = digest(canonical(config).encode())
    manifest = {'config': config, 'config_sha256': config_hash,
        'python': platform.python_version(), 'platform': platform.platform(),
        'query_ids': [q['id'] for q in queries], 'gold_loaded': False,
        'quality_scope': 'retrieval_diagnostic_not_answer_quality',
        'all_scope_results_exploratory': split == 'all', 'model_calls': 0, 'memz_runs': 0,
        'raw_full_warning': 'raw_no_budget_unfair_vs_budgeted_methods',
        'input_tokens': None, 'output_tokens': None, 'cost': None,
        'generation_ms': None, 'end_to_end_generation_ms': None}
    rows = []
    randomizer = random.Random(seed)
    for query in queries:
        methods = list(METHODS)
        randomizer.shuffle(methods)
        documents = chosen[query['scope']]
        for method in methods:
            start = time.perf_counter_ns()
            error = None
            skipped = []
            try:
                if method == 'no_memory':
                    docs = []
                elif method == 'raw_full':
                    docs = documents
                elif method == 'raw_budget_recency':
                    docs, skipped = select(documents, range(len(documents) - 1, -1, -1), budget)
                    docs.reverse()  # Context chronological; selection newest-first.
                else:
                    docs, skipped = select(documents, indexes[query['scope']].rank(query['question']), budget)
                payload = context(docs)
            except Exception as exc:  # Keep the query/method in every denominator.
                docs, payload = [], b''
                error = {'type': type(exc).__name__, 'message': str(exc)}
            elapsed = (time.perf_counter_ns() - start) / 1e6
            rows.append({'id': query['id'], 'scope': query['scope'], 'split': assignments[query['scope']],
                'method': method, 'config_sha256': config_hash,
                'retrieved_ids': [d['id'] for d in docs], 'skipped_budget_ids': skipped,
                'context_bytes': len(payload), 'context_sha256': digest(payload),
                'budget_bytes': None if method == 'raw_full' else budget,
                'raw_no_budget_unfair': method == 'raw_full',
                'unused_budget_bytes': None if method == 'raw_full' else budget - len(payload),
                'retrieval_assembly_ms': elapsed, 'error': error,
                'status': 'error' if error else 'retrieval_only_no_generation',
                'input_tokens': None, 'output_tokens': None, 'cost': None,
                'generation_ms': None, 'end_to_end_generation_ms': None, 'answer_quality': None})
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / 'manifest.json', manifest)
    write_jsonl(output / 'index.jsonl', index_rows)
    write_jsonl(output / 'retrieval.jsonl', rows)
    return {'queries': len(queries), 'scopes': len(chosen), 'rows': len(rows),
            'errors': sum(r['error'] is not None for r in rows), 'config_sha256': config_hash}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpora', type=Path, required=True)
    parser.add_argument('--queries', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--budget-bytes', type=int, default=8192)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--dev-scopes', type=int, default=2)
    parser.add_argument('--split', choices=['all', 'dev', 'test'], default='all')
    args = parser.parse_args()
    print(canonical(run(args.corpora, args.queries, args.output, args.budget_bytes,
                        args.seed, args.dev_scopes, args.split)))


if __name__ == '__main__':
    main()
