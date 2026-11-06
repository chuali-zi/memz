#!/usr/bin/env python3
"""Offline exact scorer; this is the only model-evaluation process reading gold."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import random
import statistics


def grade(call, gold):
    result = {'answer_correct': False, 'citation_correct': False, 'valid_json': False,
              'abstained': False, 'service_ok': call.get('status') == 'ok'}
    if call.get('status') != 'ok' or call.get('finish_reason') != 'stop': return result
    try:
        answer = json.loads(call['answer'])
        if set(answer) != {'answer', 'abstain', 'source_ids'}: return result
        if not isinstance(answer['answer'], list) or any(not isinstance(v, str) for v in answer['answer']): return result
        if type(answer['abstain']) is not bool or not isinstance(answer['source_ids'], list): return result
        if any(type(v) is not int or v <= 0 for v in answer['source_ids']): return result
        if len(set(answer['source_ids'])) != len(answer['source_ids']): return result
        if answer['abstain'] and (answer['answer'] or answer['source_ids']): return result
        result.update(valid_json=True, abstained=answer['abstain'])
        result['answer_correct'] = answer['answer'] == gold['answer'] and answer['abstain'] == gold['abstain']
        result['citation_correct'] = result['answer_correct'] and set(answer['source_ids']) == set(gold['sourceIds'])
    except (ValueError, TypeError, KeyError):
        pass
    return result


def summarize(rows):
    result = {'n': len(rows)}
    for field in ('answer_correct', 'citation_correct', 'valid_json', 'abstained', 'service_ok'):
        result[field] = sum(r[field] for r in rows)
    result['accuracy'] = result['answer_correct'] / len(rows)
    for field in ('prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'):
        values = [r.get('usage', {}).get(field) for r in rows if r.get('usage') is not None]
        values = [v for v in values if v is not None]
        result[field] = {'measured': len(values), 'sum': sum(values) if values else None,
                         'mean': statistics.mean(values) if values else None}
    times = [r['latency_seconds'] for r in rows if r.get('latency_seconds') is not None]
    result['latency_seconds'] = {'n': len(times), 'mean': statistics.mean(times) if times else None,
        'p50': statistics.median(times) if times else None,
        'p95': sorted(times)[max(0, int(len(times)*.95 + .999999)-1)] if times else None}
    return result


def paired_cluster(rows, left, right):
    by_scope = collections.defaultdict(lambda: collections.defaultdict(list))
    for row in rows: by_scope[row['scope']][row['arm']].append(row['answer_correct'])
    differences = [statistics.mean(v[left])-statistics.mean(v[right]) for v in by_scope.values()]
    rng = random.Random(20261106)
    samples = sorted(statistics.mean(rng.choices(differences, k=len(differences))) for _ in range(10000))
    return {'left': left, 'right': right, 'scope_count': len(differences),
        'accuracy_difference': statistics.mean(differences), 'bootstrap_95_percentile': [samples[249], samples[9749]],
        'caveat': 'few synthetic template-related scopes; descriptive interval, not proof of population equivalence'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--export', required=True); p.add_argument('--run', required=True); p.add_argument('--output', required=True)
    args = p.parse_args(); root = Path(args.export); run = Path(args.run)
    config = json.loads((run/'config.json').read_text())
    raw = (root/'inputs.jsonl').read_bytes()
    if hashlib.sha256(raw).hexdigest() != config['input_sha256']: raise ValueError('input_hash_mismatch')
    inputs = {r['id']: r for r in map(json.loads, raw.splitlines()) if r['id'].startswith(config['split']+'/')
              and (not config.get('arms') or r['id'].rsplit('/',1)[1] in config['arms'])}
    gold = {r['questionId']: r for r in json.loads((root/'gold.private.json').read_text())}
    calls = {}; call_bytes = (run/'calls.jsonl').read_bytes()
    for line in call_bytes.splitlines():
        call = json.loads(line); key = (call['id'], call['repetition'])
        if key in calls or key[0] not in inputs or type(key[1]) is not int or not 0 <= key[1] < config['repeats']:
            raise ValueError('unexpected_or_duplicate_call')
        calls[key] = call
    graded = []
    for row_id in inputs:
        question_id, arm = row_id.rsplit('/', 1); truth = gold[question_id]
        for repetition in range(config['repeats']):
            call = calls.get((row_id, repetition), {'status': 'missing'})
            graded.append({'id': row_id, 'repetition': repetition, 'scope': truth['scope'],
                'category': truth['category'], 'arm': arm, **grade(call, truth),
                'usage': call.get('usage'), 'latency_seconds': call.get('latency_seconds'),
                'error': call.get('error'), 'status': call['status']})
    arms = sorted({r['arm'] for r in graded}); categories = sorted({r['category'] for r in graded})
    report = {'schema': 'memz-deepseek-score-v1', 'synthetic': True, 'split': config['split'],
        'planned': len(inputs)*config['repeats'], 'recorded': len(calls), 'repeats': config['repeats'],
        'unique_questions': len(inputs)//len(arms), 'calls_sha256': hashlib.sha256(call_bytes).hexdigest(),
        'gold_sha256': hashlib.sha256((root/'gold.private.json').read_bytes()).hexdigest(),
        'scorer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'arms': {arm: summarize([r for r in graded if r['arm']==arm]) for arm in arms},
        'categories': {category: {arm: summarize([r for r in graded if r['category']==category and r['arm']==arm])
                      for arm in arms} for category in categories},
        'paired': [paired_cluster(graded, left, right) for left in ('memz_reader','memz_history') for right in ('memz_full', 'full_history', 'no_memory') if left in arms and right in arms],
        'failures': [r for r in graded if not r['answer_correct']], 'scoring': 'strict literal arrays, exact citations, all planned calls in denominator'}
    with Path(args.output).open('x') as out: json.dump(report, out, ensure_ascii=False, indent=2); out.write('\n')
    print(json.dumps({'split': report['split'], 'arms': report['arms'], 'paired': report['paired']}, ensure_ascii=False))


if __name__ == '__main__': main()
