#!/usr/bin/env python3
"""Offline data normalization. No model/API imports, no database writes.

Memory input, public queries and evaluator-only labels are separate files.
This is a loading adapter, not a memz implementation or official scorer.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def locomo(path):
    for si, sample in enumerate(json.loads(path.read_text(encoding='utf-8'))):
        scope = f'locomo:{si}:{sample["sample_id"]}'
        conversation = sample['conversation']
        documents = []
        sessions = sorted((k for k in conversation if re.fullmatch(r'session_\d+', k)),
                          key=lambda k: int(k.split('_')[1]))
        for key in sessions:
            date = conversation.get(key + '_date_time', '')
            for turn in conversation[key]:
                # Deliberate allowlist: no released observations/summaries/QA labels.
                text = f'{turn["speaker"]}: {turn["text"]}'
                if turn.get('blip_caption'):
                    text += '\n[Image caption] ' + turn['blip_caption']
                documents.append({'id': turn['dia_id'], 'session_id': key,
                                  'date': date, 'text': text})
        questions, labels = [], []
        for qi, qa in enumerate(sample['qa']):
            qid = f'{scope}:q{qi}'
            questions.append({'id': qid, 'scope': scope, 'question': qa['question']})
            labels.append({'id': qid, 'category': str(qa['category']),
                           'answer': qa.get('answer'),
                           'adversarial_answer': qa.get('adversarial_answer'),
                           'evidence_ids': qa.get('evidence', []),
                           'official_metric': 'locomo_category_dependent_f1_or_abstention'})
        yield {'scope': scope, 'documents': documents}, questions, labels


def longmemeval(path):
    for sample in json.loads(path.read_text(encoding='utf-8')):
        scope = f'longmemeval:{sample["question_id"]}'
        ids, dates, sessions = (sample[k] for k in
                               ['haystack_session_ids', 'haystack_dates', 'haystack_sessions'])
        if not len(ids) == len(dates) == len(sessions):
            raise ValueError('session/id/date alignment mismatch')
        documents = []
        # Preserve released order, including unsorted oracle sessions. Do not sort oracle
        # silently or use has_answer to choose memory input.
        for sid, date, session in zip(ids, dates, sessions):
            documents.append({'id': str(sid), 'session_id': str(sid), 'date': date,
                              'text': '\n'.join(f'{t["role"]}: {t["content"]}' for t in session)})
        qid = scope + ':q0'
        yield ({'scope': scope, 'documents': documents},
               [{'id': qid, 'scope': scope, 'question': sample['question'],
                 'date': sample['question_date']}],
               [{'id': qid, 'category': sample['question_type'], 'answer': sample['answer'],
                 'abstention': str(sample['question_id']).endswith('_abs'),
                 'evidence_ids': [str(i) for i in sample['answer_session_ids']],
                 'official_metric': 'official_longmemeval_llm_judge'}])


def mab(path, source):
    # Optional dependency only used for real local parquet files. No remote loader.
    import pyarrow.parquet as pq
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(batch_size=1):
        for row in batch.to_pylist():
            metadata = row.get('metadata') or {}
            if source and metadata.get('source') != source:
                continue
            row_index = mab.row_index
            mab.row_index += 1
            scope = f'mab:{path.stem}:{row_index}'
            questions, answers = row['questions'], row['answers']
            if len(questions) != len(answers):
                raise ValueError('question/answer alignment mismatch')
            qs, labels = [], []
            for i, (q, answer) in enumerate(zip(questions, answers)):
                qid = f'{scope}:q{i}'
                # Source-specific instruction templates and sentence/token chunking
                # must be applied by a future official-run adapter, not guessed here.
                qs.append({'id': qid, 'scope': scope, 'question': q})
                labels.append({'id': qid, 'category': metadata.get('source'),
                               'answer': answer, 'evidence_ids': [],
                               'official_metric': 'see_official_source_to_metric_mapping',
                               'official_metadata': metadata})
            yield ({'scope': scope, 'documents': [{'id': 'context', 'date': None,
                    'session_id': 'context', 'text': row['context']}]}, qs, labels)


mab.row_index = 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dataset', choices=['locomo', 'longmemeval', 'mab'], required=True)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--source', help='MAB metadata.source exact filter')
    args = p.parse_args()
    if not args.input.is_file():
        p.error(f'missing local data: {args.input}; no download attempted')
    args.output.mkdir(parents=True, exist_ok=True)
    names = ['corpora.jsonl', 'queries.jsonl', 'gold.private.jsonl']
    if any((args.output / name).exists() for name in names):
        p.error('output already contains normalized data; choose a fresh output directory')
    loader = mab(args.input, args.source) if args.dataset == 'mab' else globals()[args.dataset](args.input)
    counts = Counter()
    seen = set()
    with ((args.output / names[0]).open('w', encoding='utf-8', newline='\n') as cf,
          (args.output / names[1]).open('w', encoding='utf-8', newline='\n') as qf,
          (args.output / names[2]).open('w', encoding='utf-8', newline='\n') as gf):
        for corpus, qs, labels in loader:
            if corpus['scope'] in seen:
                raise ValueError('duplicate corpus scope')
            seen.add(corpus['scope'])
            doc_ids = [d['id'] for d in corpus['documents']]
            if len(doc_ids) != len(set(doc_ids)):
                raise ValueError('duplicate document IDs within scope')
            counts['corpora'] += 1
            counts['documents'] += len(doc_ids)
            counts['questions'] += len(qs)
            cf.write(json.dumps(corpus, ensure_ascii=False) + '\n')
            for q, label in zip(qs, labels):
                if q['id'] != label['id']:
                    raise ValueError('ID alignment mismatch')
                counts['category:' + str(label['category'])] += 1
                qf.write(json.dumps(q, ensure_ascii=False) + '\n')
                gf.write(json.dumps(label, ensure_ascii=False) + '\n')
    if not counts['corpora']:
        raise ValueError('no input records matched')
    report = {'status': 'offline_read_verified', 'dataset': args.dataset,
              'input_sha256': sha(args.input), 'counts': dict(counts),
              'output_sha256': {n: sha(args.output / n) for n in names},
              'model_calls': 0, 'memz_runs': 0,
              'note': 'MAB is a format loader; not an official task execution adapter.'}
    (args.output / 'load-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
