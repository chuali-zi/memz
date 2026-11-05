"""Original synthetic regressions; no upstream dataset or model calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class OfflinePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='memz-offline-test-')
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)

    def run_script(self, name, *args, ok=True):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / name), *map(str, args)],
                                capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def fixture(self):
        return [{'sample_id': f'original-synthetic-{i}',
                 'conversation': {'session_1_date_time': '2026-01-01', 'session_1': [
                     {'dia_id': 'D1:1', 'speaker': 'Speaker', 'text': f'specialword scope-{i} 中文🙂',
                      'blip_caption': f'caption-{i}', 'img_url': 'https://invalid.example/image'}]},
                 'qa': [{'question': 'specialword?', 'answer': f'EVALUATOR_ONLY_{i}',
                         'evidence': ['D1:1'], 'category': 2}],
                 'observation': 'DERIVED_SUMMARY_MUST_NOT_ENTER_MEMORY'} for i in range(2)]

    def prepare(self, data=None):
        path = self.work / 'raw.json'
        path.write_text(json.dumps(data if data is not None else self.fixture()))
        output = self.work / 'prepared'
        self.run_script('prepare.py', '--dataset', 'locomo', '--input', path, '--output', output)
        return path, output

    def test_gold_separation_and_scope_isolation(self):
        _, output = self.prepare()
        memory = (output / 'corpora.jsonl').read_text(encoding='utf-8')
        public_queries = (output / 'queries.jsonl').read_text(encoding='utf-8')
        for hidden in ['EVALUATOR_ONLY', 'DERIVED_SUMMARY', 'img_url', 'invalid.example']:
            self.assertNotIn(hidden, memory + public_queries)
        self.assertIn('caption-0', memory)
        self.assertIn('中文🙂', memory)
        trace = self.work / 'trace.jsonl'
        self.run_script('offline_smoke.py', '--prepared', output, '--limit', 0, '--output', trace)
        rows = [json.loads(s) for s in trace.read_text().splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r['scope'] for r in rows}), 2)
        self.assertEqual(len({r['context_sha256'] for r in rows}), 2)
        self.assertTrue(all(r['retrieved_ids'] == ['D1:1'] for r in rows))
        self.assertTrue(all(r['answer_quality'] is None and r['input_tokens'] is None for r in rows))

    def test_injected_answer_rejected_before_output(self):
        _, output = self.prepare()
        path = output / 'queries.jsonl'
        rows = [json.loads(s) for s in path.read_text().splitlines()]
        rows[0]['answer'] = 'FORBIDDEN_LABEL'
        path.write_text('\n'.join(json.dumps(q) for q in rows) + '\n')
        trace = self.work / 'must-not-exist.jsonl'
        self.run_script('offline_smoke.py', '--prepared', output, '--output', trace, ok=False)
        self.assertFalse(trace.exists())

    def test_duplicate_document_ids_rejected(self):
        data = self.fixture()
        data[0]['conversation']['session_1'].append(data[0]['conversation']['session_1'][0])
        path = self.work / 'duplicates.json'
        path.write_text(json.dumps(data))
        output = self.work / 'partial'
        self.run_script('prepare.py', '--dataset', 'locomo', '--input', path, '--output', output, ok=False)
        self.assertFalse((output / 'load-report.json').exists())

    def test_missing_data_fails_without_creating_output(self):
        output = self.work / 'must-not-exist'
        self.run_script('prepare.py', '--dataset', 'longmemeval', '--input',
                        self.work / 'missing.json', '--output', output, ok=False)
        self.assertFalse(output.exists())

    def test_longmemeval_strips_evidence_flags_preserves_answer_type(self):
        path = self.work / 'original-lme-fixture.json'
        path.write_text(json.dumps([{'question_id': 'original-fixture', 'question_type': 'knowledge-update',
            'question': 'What changed?', 'question_date': '2026-01-02', 'answer': 7,
            'haystack_session_ids': ['s1'], 'haystack_dates': ['2026-01-01'],
            'haystack_sessions': [[{'role': 'user', 'content': 'The value changed.', 'has_answer': True}]],
            'answer_session_ids': ['s1']}]))
        output = self.work / 'lme'
        self.run_script('prepare.py', '--dataset', 'longmemeval', '--input', path, '--output', output)
        self.assertNotIn('has_answer', (output / 'corpora.jsonl').read_text())
        self.assertNotIn('answer', (output / 'queries.jsonl').read_text())
        self.assertEqual(json.loads((output / 'gold.private.jsonl').read_text())['answer'], 7)

    def test_explicit_unmanaged_opt_in_cannot_override_managed_denial(self):
        spec = importlib.util.spec_from_file_location('acquire', ROOT / 'scripts/acquire.py')
        acquire = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(acquire)
        with patch.object(acquire.Path, 'exists', return_value=False):
            self.assertFalse(acquire.allowed('https://example.invalid'))
            self.assertTrue(acquire.allowed('https://example.invalid', True))
        policy = json.dumps({'version': 1, 'http_network_policy': {'type': 'restricted', 'egress_rules': []}})
        with (patch.object(acquire.Path, 'exists', return_value=True),
              patch.object(acquire.Path, 'read_text', return_value=policy)):
            self.assertFalse(acquire.allowed('https://example.invalid', True))


if __name__ == '__main__':
    unittest.main()
