"""Reader export must reproduce the scored context without labels."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import retrieval_common as common
import retrieval_export as exporter
import retrieval_run as runner


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.corpora, self.queries = self.root / 'corpora.jsonl', self.root / 'queries.jsonl'
        common.write_jsonl(self.corpora, [{'scope': 'a', 'documents': [
            {'id': 'd', 'session_id': 's', 'date': None, 'text': 'apple 中文🙂'}]}])
        common.write_jsonl(self.queries, [{'id': 'q', 'scope': 'a', 'question': 'apple'}])
        self.run = self.root / 'run'
        runner.run(self.corpora, self.queries, self.run, dev_scopes=0)
        self.output = self.root / 'reader.jsonl'

    def export(self):
        return exporter.export(self.run, self.corpora, self.queries, self.output, 'bm25_raw', 'test', 0)

    def test_exact_contract_context_hash_and_no_overwrite(self):
        self.export()
        row = common.read_jsonl(self.output)[0]
        self.assertEqual(set(row), {'id', 'query', 'context'})
        trace = next(r for r in common.read_jsonl(self.run / 'retrieval.jsonl') if r['method'] == 'bm25_raw')
        self.assertEqual(common.digest(row['context'].encode()), trace['context_sha256'])
        self.assertEqual(len(row['context'].encode()), trace['context_bytes'])
        metadata = json.loads(self.output.with_name('reader.jsonl.manifest.json').read_text())
        self.assertEqual(metadata['output_sha256'], common.file_hash(self.output))
        self.assertFalse(metadata['gold_loaded'])
        with self.assertRaisesRegex(ValueError, 'exists'):
            self.export()

    def test_tampered_context_fails_before_output(self):
        traces = common.read_jsonl(self.run / 'retrieval.jsonl')
        for row in traces:
            if row['method'] == 'bm25_raw':
                row['context_sha256'] = 'tampered'
        (self.run / 'retrieval.jsonl').write_text(''.join(common.canonical(r) + '\n' for r in traces))
        with self.assertRaisesRegex(ValueError, 'context hash/bytes mismatch'):
            self.export()
        self.assertFalse(self.output.exists())

    def test_missing_trace_is_not_silently_skipped(self):
        (self.run / 'retrieval.jsonl').write_text('')
        with self.assertRaisesRegex(ValueError, 'missing/failed'):
            self.export()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
