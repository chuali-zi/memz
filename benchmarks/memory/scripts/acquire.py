#!/usr/bin/env python3
"""Verify pinned public files; download only on explicit --download.

Preserves proxy/CA configuration, checks managed HTTP policy, never retries
403/auth/network denials, writes only a .part until length+SHA256 match.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def allowed(url, allow_unmanaged=False):
    policy_path = Path('/etc/codex/network-policy.json')
    if not policy_path.exists():
        return allow_unmanaged  # Explicit opt-in on ordinary hosts without a managed policy.
    policy = json.loads(policy_path.read_text(encoding='utf-8'))
    if policy.get('version') != 1:
        return False
    http = policy.get('http_network_policy') or {}
    if http.get('type') == 'unrestricted':
        return True
    host = urlparse(url).hostname
    return any(rule.get('host') == host for rule in http.get('egress_rules', []))


def target(path):
    p = (ROOT / path).resolve()
    if not p.is_relative_to(ROOT):
        raise ValueError('manifest path escapes task directory')
    return p


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--only', nargs='+', help='file IDs from manifest.lock.json')
    p.add_argument('--download', action='store_true')
    p.add_argument('--allow-unmanaged-network', action='store_true',
                   help='allow explicit downloads only when no managed policy file exists; never overrides one')
    p.add_argument('--import-root', type=Path,
                   help='copy matching relative paths from a mounted transfer directory, after validation')
    args = p.parse_args()
    lock = json.loads((ROOT / 'manifest.lock.json').read_text(encoding='utf-8'))
    files = [f for f in lock['files'] if not args.only or f['id'] in args.only]
    if args.only and set(args.only) - {f['id'] for f in files}:
        p.error('unknown file ID')
    rows = []
    for item in files:
        path = target(item['path'])
        row = {'id': item['id'], 'path': item['path'], 'status': 'missing',
               'actual_bytes': None, 'actual_sha256': None}
        expected = item.get('sha256')
        size = item.get('bytes')
        if not path.exists() and args.import_root:
            candidate = args.import_root / item['path']
            if candidate.is_file() and expected and digest(candidate) == expected:
                if size is not None and candidate.stat().st_size != size:
                    raise ValueError('transfer size mismatch')
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(candidate, path)
        if not path.exists() and args.download:
            if not expected:
                row['status'] = 'blocked_unpinned_checksum'
            elif not allowed(item['url'], args.allow_unmanaged_network):
                row['status'] = 'blocked_network_policy_no_request_sent'
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                part = path.with_name(path.name + '.part')
                if part.exists():
                    row['status'] = 'partial_exists_manual_review_required'
                else:
                    try:
                        with urlopen(item['url'], timeout=60) as response, part.open('xb') as out:
                            shutil.copyfileobj(response, out, length=1024 * 1024)
                        if size is not None and part.stat().st_size != size:
                            raise ValueError('download size mismatch')
                        if digest(part) != expected:
                            raise ValueError('download checksum mismatch')
                        part.replace(path)
                    except Exception as exc:
                        # Do not print provider response text or signed redirect URLs.
                        row['status'] = 'download_failed_no_retry'
                        row['error_type'] = type(exc).__name__
        if path.is_file():
            row['actual_bytes'] = path.stat().st_size
            row['actual_sha256'] = digest(path)
            row['status'] = ('verified' if expected and row['actual_sha256'] == expected
                             and (size is None or row['actual_bytes'] == size)
                             else 'present_unverified' if not expected else 'mismatch')
        rows.append(row)
        print(f'{row["id"]}: {row["status"]}')
    report = {'scope': 'selected_files_only', 'network_requested': args.download,
              'files': rows}
    reports = ROOT / 'reports'
    reports.mkdir(exist_ok=True)
    (reports / 'acquisition-status.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    sys.exit(0 if all(r['status'] == 'verified' for r in rows) else 2)


if __name__ == '__main__':
    main()
