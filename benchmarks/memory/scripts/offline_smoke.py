#!/usr/bin/env python3
"""Exercise query->BM25->context locally. No generation, tokens, or memz claims."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re


def words(text):
    return re.findall(r'\w+', text.lower())


class BM25:
    def __init__(self, documents):
        self.documents = documents
        self.freqs = [Counter(words(d['text'])) for d in documents]
        self.lengths = [sum(f.values()) for f in self.freqs]
        self.avg = sum(self.lengths) / len(documents) if documents else 1
        self.df = Counter(t for f in self.freqs for t in f)

    def retrieve(self, question, k):
        query = set(words(question))
        n = len(self.documents)
        scores = []
        for i, f in enumerate(self.freqs):
            score = 0.0
            for term in query:
                tf = f[term]
                if tf:
                    idf = math.log(1 + (n - self.df[term] + .5) / (self.df[term] + .5))
                    score += idf * tf * 2.5 / (tf + 1.5 * (.25 + .75 * self.lengths[i] / (self.avg or 1)))
            if score > 0:
                scores.append((score, i))
        return [self.documents[i] for _, i in sorted(scores, key=lambda x: (-x[0], x[1]))[:k]]


def read(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--prepared', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--limit', type=int, default=8, help='0 means all questions')
    p.add_argument('--top-k', type=int, default=8)
    args = p.parse_args()
    if args.limit < 0 or args.top_k < 1:
        p.error('limit >= 0 and top-k >= 1 required')
    corpora = read(args.prepared / 'corpora.jsonl')
    queries = read(args.prepared / 'queries.jsonl')
    # Do not load gold.private.jsonl into the retrieval process.
    permitted_query_keys = {'id', 'scope', 'question', 'date'}
    forbidden = {'answer', 'evidence', 'has_answer', 'qa', 'observation', 'session_summary'}
    for q in queries:
        if set(q) - permitted_query_keys:
            raise ValueError('unexpected query metadata; possible evaluation leakage')
    for c in corpora:
        if set(c) != {'scope', 'documents'}:
            raise ValueError('unexpected memory metadata')
        for d in c['documents']:
            if set(d) & forbidden or set(d) != {'id', 'session_id', 'date', 'text'}:
                raise ValueError('unexpected memory fields; possible evaluation leakage')
    indexes = {c['scope']: BM25(c['documents']) for c in corpora}
    selected = queries if not args.limit else queries[:args.limit]
    if args.output.exists():
        p.error('output exists; choose a fresh output file')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', encoding='utf-8', newline='\n') as out:
        for q in selected:
            docs = indexes[q['scope']].retrieve(q['question'], args.top_k)
            context = '\n\n'.join(f'[{d["id"]}] {d["date"]}\n{d["text"]}' for d in docs)
            row = {'id': q['id'], 'scope': q['scope'], 'system': 'offline_bm25_turn',
                   'retrieved_ids': [d['id'] for d in docs],
                   'context_bytes': len(context.encode()),
                   'context_sha256': hashlib.sha256(context.encode()).hexdigest(),
                   'status': 'retrieval_only_no_generation', 'input_tokens': None,
                   'output_tokens': None, 'answer_quality': None}
            out.write(json.dumps(row) + '\n')
    print(json.dumps({'status': 'offline_smoke_passed', 'queries': len(selected),
                      'corpora': len(corpora), 'model_calls': 0, 'memz_runs': 0,
                      'gold_loaded': False, 'result': str(args.output)}, indent=2))


if __name__ == '__main__':
    main()
