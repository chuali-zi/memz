#!/usr/bin/env python3
"""Run a preregistered paired synthetic experiment; this process never opens gold."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import time
from deepseek_adapter import complete, encode, prepare, SYSTEM


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', required=True); p.add_argument('--output', required=True)
    p.add_argument('--split', choices=['dev', 'heldout'], required=True)
    p.add_argument('--repeats', type=int, default=1)
    p.add_argument('--model', default='deepseek-flash'); p.add_argument('--execute', action='store_true')
    p.add_argument('--arms', nargs='+', choices=['no_memory','full_history','memz_full','memz_reader','memz_history'])
    args = p.parse_args()
    if not 1 <= args.repeats <= 3: raise ValueError('invalid_repeats')
    raw = Path(args.input).read_bytes()
    if len(raw) > 8 * 1024 * 1024: raise ValueError('input_file_too_large')
    rows = [json.loads(line) for line in raw.splitlines()]
    if len({r['id'] for r in rows}) != len(rows): raise ValueError('duplicate_ids')
    for row in rows: prepare(row, args.model)
    rows = [r for r in rows if r['id'].startswith(args.split + '/') and (not args.arms or r['id'].rsplit('/',1)[1] in args.arms)]
    if not rows or len(rows) * args.repeats > 400: raise ValueError('call_budget_exceeded')
    if sum(len(prepare(r, args.model)) for r in rows) * args.repeats > 12 * 1024 * 1024:
        raise ValueError('total_input_budget_exceeded')
    directory = Path(args.output); directory.mkdir(parents=True, exist_ok=False)
    config = {'schema': 'memz-deepseek-run-v1', 'model': args.model, 'split': args.split,
        'repeats': args.repeats, 'arms': sorted({r['id'].rsplit('/',1)[1] for r in rows}), 'max_calls': len(rows) * args.repeats, 'max_output_tokens': 256,
        'reserved_output_tokens': len(rows) * args.repeats * 256, 'concurrency': 2,
        'temperature': 0, 'thinking': 'disabled', 'timeout_seconds': 45, 'attempts_per_call': 1,
        'input_sha256': hashlib.sha256(raw).hexdigest(), 'system_sha256': hashlib.sha256(SYSTEM.encode()).hexdigest(),
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'working_tree_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
        'scripts_sha256': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                           for name in ('deepseek_adapter.py', 'deepseek_run.py')},
        'execute': args.execute, 'started_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'timing_scope': 'provider request including Python worker startup; retrieval/export measured separately; not online end-to-end',
        'order': 'question blocks; arm rotation by question and repetition; two concurrent requests; no answer cache'}
    (directory / 'config.json').write_bytes(encode(config) + b'\n')
    groups = {}
    for row in rows: groups.setdefault(row['id'].rsplit('/', 1)[0], []).append(row)
    tasks = []
    for repetition in range(args.repeats):
        for i, group in enumerate(groups.values()):
            offset = (i + repetition) % len(group)
            tasks.extend((row, repetition) for row in group[offset:] + group[:offset])
    # Bounded batches prevent queued calls continuing after a provider error.
    stopped = False
    with (directory / 'calls.jsonl').open('xb') as out, concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        for start in range(0, len(tasks), 2):
            batch = tasks[start:start + 2]
            if stopped:
                for row, repetition in batch:
                    out.write(encode({'id': row['id'], 'repetition': repetition, 'status': 'not_run', 'error': 'run_halted', 'attempts': 0, 'usage': None}) + b'\n')
                continue
            futures = [executor.submit(complete, row, model=args.model, execute=args.execute) for row, _ in batch]
            for (row, repetition), future in zip(batch, futures):
                result = future.result(); result['repetition'] = repetition
                out.write(encode(result) + b'\n'); out.flush()
                if result['status'] == 'error': stopped = True
            print(json.dumps({'completed': start + len(batch), 'planned': len(tasks), 'stopped': stopped}), flush=True)
    return int(stopped)


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception:
        print('{"error":"preflight_or_file_error"}'); raise SystemExit(1)
