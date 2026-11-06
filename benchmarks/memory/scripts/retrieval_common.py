"""Shared deterministic serialization/validation; no dataset or model dependencies."""
import hashlib
import json
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_hash(path):
    return digest(Path(path).read_bytes())


def read_jsonl(path):
    with Path(path).open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def write_jsonl(path, rows):
    with Path(path).open('x', encoding='utf-8') as stream:
        for row in rows:
            stream.write(canonical(row) + '\n')


def identifier(value):
    return isinstance(value, str) and bool(value)


def validate_corpora(rows):
    result = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'scope', 'documents'}:
            raise ValueError('unexpected corpus fields: possible label leakage')
        scope = row['scope']
        if not identifier(scope) or scope in result:
            raise ValueError('invalid or duplicate scope')
        if not isinstance(row['documents'], list):
            raise ValueError('documents must be a list')
        ids = set()
        for doc in row['documents']:
            if not isinstance(doc, dict) or set(doc) != {'id', 'session_id', 'date', 'text'}:
                raise ValueError('unexpected document fields: possible label leakage')
            if not identifier(doc['id']) or doc['id'] in ids:
                raise ValueError('invalid or duplicate document ID within scope')
            if not isinstance(doc['text'], str) or not identifier(doc['session_id']):
                raise ValueError('invalid document text/session')
            if doc['date'] is not None and not isinstance(doc['date'], str):
                raise ValueError('document date must be string or null')
            ids.add(doc['id'])
        result[scope] = row['documents']
    return result


def validate_queries(rows, corpora):
    seen = set()
    for row in rows:
        if (not isinstance(row, dict) or set(row) - {'id', 'scope', 'question', 'date'}
                or not {'id', 'scope', 'question'} <= set(row)):
            raise ValueError('unexpected query fields: possible label leakage')
        if not identifier(row['id']) or row['id'] in seen:
            raise ValueError('invalid or duplicate query ID')
        if row['scope'] not in corpora or not isinstance(row['question'], str):
            raise ValueError('unknown query scope or invalid question')
        if row.get('date') is not None and not isinstance(row['date'], str):
            raise ValueError('query date must be string or null')
        seen.add(row['id'])
    return rows


def serialize_document(doc):
    # Same frame for every method; session and date remain available to a reader.
    return f'[{doc["id"]}] session={doc["session_id"]} date={doc["date"]}\n{doc["text"]}'


def context(documents):
    return '\n\n'.join(serialize_document(doc) for doc in documents).encode('utf-8')


def scope_split(scopes, seed, dev_scopes):
    ordered = sorted(scopes, key=lambda s: (digest(f'{seed}\0{s}'.encode()), s))
    if dev_scopes < 0 or (ordered and dev_scopes >= len(ordered)):
        raise ValueError('dev-scopes must be >= 0 and leave at least one test scope')
    return {scope: ('dev' if i < dev_scopes else 'test') for i, scope in enumerate(ordered)}
