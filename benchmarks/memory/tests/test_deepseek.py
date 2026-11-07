import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from deepseek_adapter import complete, prepare
from deepseek_score import grade


class DeepSeekTests(unittest.TestCase):
    def setUp(self):
        self.row = {'id': 'dev/scope-1/q-1/memz_reader', 'query': '何时？', 'context': '不可信文本'}

    def test_gold_fields_and_oversized_input_rejected(self):
        for row in ({**self.row, 'answer': 'leak'}, {**self.row, 'context': '字'*65536}):
            with self.assertRaises(ValueError): prepare(row)

    def test_dry_run_never_calls_transport(self):
        result = complete(self.row, transport_fn=lambda *args: self.fail('network'))
        self.assertEqual(result['status'], 'dry_run'); self.assertEqual(result['attempts'], 0)

    def test_request_configuration_and_usage(self):
        def transport(body, key, timeout):
            request = json.loads(body)
            self.assertEqual(request['thinking'], {'type': 'disabled'})
            self.assertEqual(request['temperature'], 0); self.assertEqual(request['max_tokens'], 256)
            self.assertEqual(set(json.loads(request['messages'][1]['content'])), {'query', 'context'})
            return {'body': json.dumps({'model': 'deepseek-flash', 'id': 'receipt', 'choices': [{'finish_reason': 'stop', 'message': {'content': '{"answer":[],"abstain":true,"source_ids":[]}'}}],
                'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30, 'prompt_cache_hit_tokens': 5, 'prompt_cache_miss_tokens': 15}}).encode()}
        with patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'test-only'}):
            result = complete(self.row, execute=True, transport_fn=transport)
        self.assertEqual(result['status'], 'ok'); self.assertEqual(result['usage']['prompt_cache_hit_tokens'], 5)
        self.assertNotIn('test-only', json.dumps(result))

    def test_provider_errors_and_malformed_responses_not_successful(self):
        for reply in ({'error': 'http_error', 'http_status': 401}, {'body': b'not-json'}):
            with patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'test-only'}):
                result = complete(self.row, execute=True, transport_fn=lambda *args: reply)
            self.assertEqual(result['status'], 'error'); self.assertEqual(result['attempts'], 1)

    def test_scoring_requires_exact_answers_valid_json_and_citations(self):
        truth = {'answer': ['15号'], 'abstain': False, 'sourceIds': [7]}
        def call(answer): return {'status': 'ok', 'finish_reason': 'stop', 'answer': json.dumps(answer)}
        correct = {'answer': ['15号'], 'abstain': False, 'source_ids': [7]}
        self.assertTrue(grade(call(correct), truth)['citation_correct'])
        self.assertTrue(grade(call({**correct, 'source_ids': [8]}), truth)['answer_correct'])
        self.assertFalse(grade(call({**correct, 'source_ids': [8]}), truth)['citation_correct'])
        for value in ({**correct, 'answer': ['20号']}, {**correct, 'source_ids': [True]}, {**correct, 'abstain': 'false'}, {**correct, 'extra': 1}):
            self.assertFalse(grade(call(value), truth)['answer_correct'])
        self.assertFalse(grade({'status': 'not_run'}, truth)['answer_correct'])
        self.assertFalse(grade({**call(correct), 'finish_reason': 'length'}, truth)['answer_correct'])

    def test_correct_unknown_is_different_from_missing_history(self):
        call = {'status': 'ok', 'finish_reason': 'stop', 'answer': '{"answer":[],"abstain":true,"source_ids":[]}'}
        self.assertTrue(grade(call, {'answer': [], 'abstain': True, 'sourceIds': []})['answer_correct'])
        self.assertFalse(grade(call, {'answer': ['old'], 'abstain': False, 'sourceIds': [1]})['answer_correct'])


if __name__ == '__main__': unittest.main()
