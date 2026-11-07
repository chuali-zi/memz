"""Original synthetic rows, counters and rates; credentials and sockets blocked."""
import concurrent.futures
import contextlib
from decimal import Decimal, ROUND_DOWN, localcontext
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import textwrap
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import deepseek_adapter as ds
import deepseek_run as runner
import glm_adapter as glm
import spend_guard

ROW = {'id': 'dev/synthetic/q0/no_memory', 'query': 'Synthetic question 0', 'context': 'Original synthetic context'}


def guarded(**changes):
    value = {'max_calls': 4, 'pricing': {'currency': 'CNY', 'input_per_million': 2, 'output_per_million': 4},
             'spend_guard': {'tokenizer_id': 'synthetic-complete-chat-v1', 'max_input_tokens': 100,
                             'max_total_input_tokens': 1000, 'max_cost': 0.01}}
    value.update(changes)
    return value


def counter(count=50):
    value = Mock(return_value=count)
    value.tokenizer_id = 'synthetic-complete-chat-v1'
    return value


def response(**changes):
    data = {'model': 'synthetic-provider-reported', 'id': 'synthetic-receipt',
            'choices': [{'finish_reason': 'stop', 'message': {'content': 'synthetic answer'}}],
            'usage': {'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53,
                      'prompt_cache_hit_tokens': 40, 'prompt_cache_miss_tokens': 10,
                      'completion_tokens_details': {'reasoning_tokens': 2}}}
    data.update(changes)
    return {'body': ds.encode(data)}


class DeepSeekGuardTests(unittest.TestCase):
    def setUp(self):
        for guard in [patch.object(os, 'environ', {}),
                      patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')),
                      patch.object(glm, 'read_credential', side_effect=AssertionError('no real credential reads')),
                      patch.object(ds, 'read_credential', side_effect=AssertionError('no real credential reads'))]:
            guard.start(); self.addCleanup(guard.stop)

    def adapter(self, config=None, *, reply=None, transport=None, tokens=None):
        transport = transport or Mock(return_value=response() if reply is None else reply)
        adapter = ds.DeepSeekAdapter(config or guarded(), execute=True, simulation=True,
                                     transport_fn=transport, token_counter=tokens or counter())
        return adapter, transport

    def test_default_dry_run_keeps_the_original_serialized_request_without_credentials(self):
        fake = Mock(side_effect=AssertionError('dry run must not send'))
        result = ds.complete(ROW, transport_fn=fake)
        self.assertEqual(result['status'], 'dry_run'); self.assertEqual(result['execution_mode'], 'dry_run')
        self.assertEqual(result['attempts'], 0); self.assertEqual(result['request_sha256'], hashlib.sha256(ds.prepare(ROW)).hexdigest())
        fake.assert_not_called(); ds.read_credential.assert_not_called()

    def test_empty_environment_qualified_imports_share_errors_and_default_to_no_credentials_or_transport(self):
        code = textwrap.dedent('''
            import json, socket
            from unittest.mock import Mock, patch
            from benchmarks.memory.scripts.glm_adapter import GLMAdapter
            from benchmarks.memory.scripts import glm_adapter as glm, deepseek_adapter as ds, deepseek_run as runner, spend_guard
            assert glm.AdapterError is ds.AdapterError is runner.AdapterError is spend_guard.AdapterError
            row = {'id':'synthetic', 'query':'Synthetic question', 'context':'Synthetic context'}
            config = {'model':'glm-test', 'max_calls':1, 'max_input_bytes':1024,
                      'max_request_bytes':4096, 'max_response_bytes':4096,
                      'max_total_input_bytes':1024, 'max_output_tokens':32,
                      'max_total_output_tokens':32, 'timeout_seconds':1}
            blocked = Mock(side_effect=AssertionError('dry run must not use credentials or transport'))
            with patch.object(socket.socket,'connect',blocked), patch.object(glm,'read_credential',blocked), patch.object(ds,'read_credential',blocked), patch.object(glm,'http_transport',blocked), patch.object(ds,'transport',blocked):
                values = [GLMAdapter(config).complete(row), ds.DeepSeekAdapter().complete(row), ds.complete(row)]
                assert all(v['status']=='dry_run' and v['attempts']==0 for v in values)
                blocked.assert_not_called()
            print(json.dumps({'qualified_imports':'passed','default_dry_runs':3,'credential_and_transport_calls':0}))
        ''')
        result = subprocess.run([sys.executable, '-B', '-c', code], cwd=Path(__file__).resolve().parents[3],
                                env={}, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(result.stderr, '')
        self.assertEqual(json.loads(result.stdout), {'qualified_imports':'passed','default_dry_runs':3,'credential_and_transport_calls':0})

    def test_empty_environment_direct_script_clis_keep_the_default_dry_run(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); source = folder / 'input.jsonl'; config = folder / 'config.json'
            source.write_bytes(ds.encode(ROW) + b'\n')
            # The default dry-run config has no guard/counter requirement.
            value = self.glm_config(); value.pop('pricing'); value.pop('spend_guard'); config.write_bytes(ds.encode(value))
            commands = [
                ['benchmarks/memory/scripts/glm_adapter.py', '--config', str(config), '--input', str(source), '--output', str(folder / 'glm.jsonl')],
                ['benchmarks/memory/scripts/deepseek_run.py', '--input', str(source), '--output', str(folder / 'deepseek'), '--split', 'dev'],
            ]
            for args in commands:
                result = subprocess.run([sys.executable, '-B', *args], cwd=root, env={}, stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(result.stderr, '')
            for path in [folder / 'glm.jsonl', folder / 'deepseek' / 'calls.jsonl']:
                row = json.loads(path.read_bytes()); self.assertEqual(row['status'], 'dry_run'); self.assertEqual(row['attempts'], 0)

    def test_execute_and_simulation_are_strict_booleans_and_cannot_silently_enable_paid_calls(self):
        for field in ('execute', 'simulation'):
            for value in ('false', '0', 1, None, [], {}):
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ds.AdapterError, 'invalid_execution_mode'):
                    ds.DeepSeekAdapter(**{field: value})
        fake = Mock()
        with self.assertRaisesRegex(ds.AdapterError, 'spend_guard_required'):
            ds.complete(ROW, execute=True, transport_fn=fake)
        with self.assertRaisesRegex(ds.AdapterError, 'spend_guard_required'):
            ds.DeepSeekAdapter(execute=True, transport_fn=fake)
        fake.assert_not_called(); ds.read_credential.assert_not_called()

    def test_simulation_requires_an_explicit_fake_transport_and_never_reads_credentials(self):
        for transport in (None, ds.transport):
            with self.assertRaisesRegex(ds.AdapterError, 'simulation_transport_required'):
                ds.DeepSeekAdapter(execute=True, simulation=True, transport_fn=transport)
        result = ds.complete(ROW, execute=True, simulation=True, transport_fn=Mock(return_value=response()))
        self.assertEqual(result['status'], 'ok'); self.assertEqual(result['execution_mode'], 'simulation')
        ds.read_credential.assert_not_called()

    def test_live_missing_counter_stops_before_credentials_even_with_a_custom_transport(self):
        for tokens in (None, Mock(), counter(True), counter(0), counter(1.5)):
            fake = Mock(); adapter = ds.DeepSeekAdapter(guarded(), execute=True, transport_fn=fake, token_counter=tokens)
            result = adapter.complete(ROW)
            self.assertIn(result['error'], ('token_counter_unavailable', 'invalid_token_count'))
            self.assertEqual(result['attempts'], 0); self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted')
            fake.assert_not_called()
        ds.read_credential.assert_not_called()

    def test_decimal_cost_reserves_complete_prompt_and_full_output_without_refunds(self):
        config = guarded(); config['spend_guard']['max_cost'] = 0.002248
        tokens = counter(); adapter, fake = self.adapter(config, tokens=tokens)
        first, second = adapter.complete(ROW), adapter.complete(ROW)
        self.assertEqual(first['spend_reservation']['request_cost_reservation'], '0.001124')
        self.assertEqual(second['spend_reservation']['cumulative_cost_reservation'], '0.002248')
        self.assertEqual(tokens.call_args.args[0], ds.prepare(ROW))
        self.assertEqual(adapter.reserved_output_tokens, 512); self.assertEqual(adapter.reserved_input_tokens, 100)
        self.assertEqual(adapter.complete(ROW)['error'], 'cost_budget_exceeded')
        self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 2)

    def test_invalid_pricing_limits_and_timeout_are_rejected_without_credentials(self):
        configs = [guarded(pricing=None), guarded(max_calls=True), guarded(max_output_tokens=257), guarded(max_total_input_bytes=0)]
        for field in ('input_per_million', 'output_per_million'):
            for value in (True, float('nan'), float('inf'), -1):
                config = guarded(); config['pricing'][field] = value; configs.append(config)
        for config in configs:
            with self.assertRaises(ds.AdapterError): ds.DeepSeekAdapter(config)
        for timeout in (0, True, float('inf'), float('nan'), 46):
            with self.assertRaisesRegex(ds.AdapterError, 'invalid_timeout'): ds.DeepSeekAdapter(timeout=timeout)

    def test_money_arithmetic_does_not_inherit_low_precision_rounding_or_traps(self):
        config = guarded(); config['pricing'] = {'currency': 'CNY', 'input_per_million': 123456, 'output_per_million': 0}
        config['spend_guard']['max_cost'] = 2.4
        with localcontext() as hostile:
            hostile.prec = 2; hostile.rounding = ROUND_DOWN; hostile.Emin = -2; hostile.Emax = 2
            for signal in hostile.traps: hostile.traps[signal] = True
            adapter, fake = self.adapter(config, tokens=counter(10), reply=response(usage={'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}))
            self.assertEqual(adapter.complete(ROW)['status'], 'ok')
            self.assertEqual(adapter.complete(ROW)['error'], 'cost_budget_exceeded')
            self.assertEqual(str(adapter.reserved_cost), '1.23456'); self.assertEqual(fake.call_count, 1)
            self.assertEqual(hostile.prec, 2); self.assertEqual(hostile.rounding, ROUND_DOWN)

    def test_smallest_float_rate_is_not_rounded_away_when_combined_with_a_large_rate(self):
        config = guarded(); config['pricing'] = {'currency': 'CNY', 'input_per_million': 1000000, 'output_per_million': 5e-324}
        config['spend_guard']['max_cost'] = 1
        adapter, fake = self.adapter(config, tokens=counter(1))
        result = adapter.complete(ROW)
        self.assertEqual(result['error'], 'cost_budget_exceeded'); self.assertEqual(result['attempts'], 0)
        self.assertEqual(adapter.reserved_cost, Decimal(0)); fake.assert_not_called()

    def test_input_token_caps_and_failed_attempts_keep_the_full_reservation_and_halt(self):
        config = guarded(); config['spend_guard']['max_input_tokens'] = 49
        adapter, fake = self.adapter(config)
        self.assertEqual(adapter.complete(ROW)['error'], 'input_token_budget_exceeded'); fake.assert_not_called()
        for reply in ({'error': 'http_error', 'http_status': 429}, {'error': 'timeout'}, {'body': b'not-json'}):
            adapter, fake = self.adapter(reply=reply)
            result = adapter.complete(ROW)
            self.assertEqual(result['status'], 'error'); self.assertEqual(result['attempts'], 1)
            self.assertEqual(adapter.reserved_cost, Decimal('0.001124'))
            self.assertEqual(adapter.reserved_input_tokens, 50); self.assertEqual(adapter.reserved_output_tokens, 256)
            self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_credentials_or_transport_failure_do_not_leak_or_refund(self):
        adapter = ds.DeepSeekAdapter(guarded(), execute=True, token_counter=counter(), transport_fn=Mock())
        with patch.object(ds, 'read_credential', side_effect=ds.AdapterError('credential_unavailable')):
            result = adapter.complete(ROW)
        self.assertEqual(result['error'], 'credential_unavailable'); self.assertEqual(result['attempts'], 0)
        self.assertEqual(adapter.reserved_cost, Decimal('0.001124')); adapter.transport.assert_not_called()
        adapter, fake = self.adapter(transport=Mock(side_effect=RuntimeError('synthetic-private-failure')))
        result = adapter.complete(ROW)
        self.assertEqual(result['error'], 'transport_error'); self.assertNotIn('synthetic-private-failure', json.dumps(result))
        self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_usage_is_required_consistent_bounded_and_failures_stop_new_calls(self):
        cases = [(None, 'usage_unverifiable'), ({'prompt_tokens': 50}, 'usage_unverifiable'),
                 ({'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 999}, 'usage_unverifiable')]
        for usage in [
                {'prompt_tokens': True, 'completion_tokens': 3, 'total_tokens': 4},
                {'prompt_tokens': 10**30, 'completion_tokens': 3, 'total_tokens': 10**30 + 3},
                {'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53, 'prompt_cache_hit_tokens': 51},
                {'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53, 'prompt_cache_hit_tokens': 30, 'prompt_cache_miss_tokens': 19},
                {'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53, 'completion_tokens_details': {'reasoning_tokens': 4}},
                {'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53, 'prompt_cache_hit_tokens': 40, 'prompt_tokens_details': {'cached_tokens': 39}}]:
            cases.append((usage, 'invalid_response'))
        for usage, error in cases:
            with self.subTest(error=error):
                adapter, fake = self.adapter(reply=response(usage=usage)); result = adapter.complete(ROW)
                self.assertEqual(result['error'], error); self.assertEqual(result['attempts'], 1)
                self.assertEqual(adapter.reserved_cost, Decimal('0.001124'))
                self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_cache_and_reasoning_are_separate_optional_measurements_not_discounted_reservations(self):
        adapter, _ = self.adapter(); result = adapter.complete(ROW)
        self.assertEqual(result['usage_details'], {'cached_tokens': 40, 'reasoning_tokens': 2})
        self.assertEqual(result['usage']['prompt_cache_miss_tokens'], 10)
        self.assertEqual(result['estimated_cost']['amount'], '0.000112')
        self.assertEqual(result['spend_reservation']['request_cost_reservation'], '0.001124')
        adapter, _ = self.adapter(reply=response(usage={'prompt_tokens': 50, 'completion_tokens': 3, 'total_tokens': 53}))
        result = adapter.complete(ROW); self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['usage_details'], {'cached_tokens': None, 'reasoning_tokens': None})
        self.assertIsNone(result['usage']['prompt_cache_hit_tokens'])

    def test_provider_overruns_finish_reason_and_large_response_halt_after_the_billed_attempt(self):
        cases = [(response(usage={'prompt_tokens': 51, 'completion_tokens': 3, 'total_tokens': 54}), 'provider_input_budget_exceeded'),
                 (response(usage={'prompt_tokens': 50, 'completion_tokens': 257, 'total_tokens': 307}), 'provider_output_budget_exceeded'),
                 (response(choices=[{'finish_reason': 'length', 'message': {'content': 'partial'}}]), 'incomplete_generation'),
                 ({'body': b'x' * 1048577}, 'response_too_large')]
        for reply, error in cases:
            adapter, fake = self.adapter(reply=reply); self.assertEqual(adapter.complete(ROW)['error'], error)
            self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_decoded_secret_echo_in_answers_identity_and_unknown_fields_is_never_retained(self):
        for changes in [
                {'choices': [{'finish_reason': 'stop', 'message': {'content': ds.SIMULATION_CREDENTIAL}}]},
                {'id': ds.SIMULATION_CREDENTIAL}, {'unknown': {'nested': ds.SIMULATION_CREDENTIAL}}]:
            adapter, fake = self.adapter(reply=response(**changes)); result = adapter.complete(ROW)
            self.assertEqual(result['error'], 'credential_reflection_detected'); self.assertIsNone(result['answer'])
            self.assertNotIn(ds.SIMULATION_CREDENTIAL, json.dumps(result)); self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted')
            self.assertEqual(fake.call_count, 1)

    def glm_config(self):
        return {'model': 'glm-test', 'max_calls': 4, 'max_input_bytes': 1024,
                'max_request_bytes': 4096, 'max_response_bytes': 1048576,
                'max_total_input_bytes': 4096, 'max_output_tokens': 32,
                'max_total_output_tokens': 128, 'timeout_seconds': 1,
                'pricing': guarded()['pricing'], 'spend_guard': guarded()['spend_guard']}

    def provider(self, name, reply):
        if name == 'deepseek': return self.adapter(reply=reply)
        fake = Mock(return_value={'status': 200, **reply})
        return glm.GLMAdapter(self.glm_config(), execute=True, simulation=True,
                              token_counter=counter(), transport=fake), fake

    def test_both_providers_reject_inner_json_escaped_values_keys_and_hidden_duplicate_values(self):
        encoded = ''.join('\\u%04x' % ord(char) for char in ds.SIMULATION_CREDENTIAL)
        contents = [
            '{"answer":["' + encoded + '"],"abstain":false,"source_ids":[1]}',
            '{"answer":["safe"],"' + encoded + '":0}',
            '{"answer":["safe"],"unknown":"' + encoded + '","unknown":"safe"}',
            '{"answer":["' + encoded + '"],"answer":["safe"]}',
        ]
        self.assertEqual(glm.SIMULATION_CREDENTIAL, ds.SIMULATION_CREDENTIAL)
        for name in ('glm', 'deepseek'):
            for content in contents:
                with self.subTest(provider=name):
                    adapter, fake = self.provider(name, response(choices=[{'finish_reason': 'stop', 'message': {'content': content}}]))
                    result = adapter.complete(ROW)
                    self.assertEqual(result['error'], 'credential_reflection_detected'); self.assertIsNone(result['answer'])
                    self.assertIsNotNone(result['spend_reservation'])
                    self.assertNotIn(encoded, json.dumps(result)); self.assertNotIn(ds.SIMULATION_CREDENTIAL, json.dumps(result))
                    self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_inner_json_scan_preserves_safe_original_answer_text_and_fails_closed_at_all_limits(self):
        safe = ' {"answer":["\\u00e9"],"abstain":false,"source_ids":[1]} '
        for name in ('glm', 'deepseek'):
            adapter, _ = self.provider(name, response(choices=[{'finish_reason': 'stop', 'message': {'content': safe}}]))
            self.assertEqual(adapter.complete(ROW)['answer'], safe)
            cases = [
                ({'unknown': ['{}'] * 65}, {}),
                ({'unknown': [0] * 100001}, {}),
                ({'unknown': '[' * 33 + '0' + ']' * 33}, {}),
                ({'unknown': '{"value":"' + 'x' * 40 + '"}'}, {'_ECHO_MAX_PARSE_BYTES': 32}),
                ({'unknown': 'x' * 80}, {'_ECHO_MAX_TEXT_BYTES': 64}),
            ]
            for changes, limits in cases:
                with self.subTest(provider=name, limits=limits), contextlib.ExitStack() as stack:
                    for key, value in limits.items(): stack.enter_context(patch.object(spend_guard, key, value))
                    adapter, fake = self.provider(name, response(**changes)); result = adapter.complete(ROW)
                    self.assertEqual(result['error'], 'credential_scan_limit_exceeded'); self.assertIsNone(result['answer'])
                    self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted'); self.assertEqual(fake.call_count, 1)

    def test_both_cli_outputs_never_persist_an_inner_json_escaped_credential(self):
        encoded = ''.join('\\u%04x' % ord(char) for char in ds.SIMULATION_CREDENTIAL)
        inner = '{"answer":["' + encoded + '"],"abstain":false,"source_ids":[1]}'
        reply = response(choices=[{'finish_reason': 'stop', 'message': {'content': inner}}])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); fake = Mock(return_value=reply)
            status, output = self.run_fixture(root, ['--execute'], simulation=True, transport_fn=fake)
            self.assertEqual(status, 1)
            text = (output / 'calls.jsonl').read_text(); rows = [json.loads(line) for line in text.splitlines()]
            self.assertEqual(rows[0]['error'], 'credential_reflection_detected'); self.assertIsNone(rows[0]['answer'])
            self.assertEqual([row['status'] for row in rows[2:]], ['not_run', 'not_run'])
            self.assertNotIn(encoded, text); self.assertNotIn(ds.SIMULATION_CREDENTIAL, text)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source, config, output = (root / name for name in ('input.jsonl', 'config.json', 'calls.jsonl'))
            source.write_bytes(ds.encode(ROW) + b'\n'); config.write_bytes(ds.encode(self.glm_config()))
            original = glm.GLMAdapter
            def simulated(config, **options):
                options['token_counter'] = counter()
                if options.get('execute'):
                    options.update(simulation=True, transport=Mock(return_value={'status': 200, **reply}))
                return original(config, **options)
            captured = io.StringIO()
            with patch.object(glm, 'GLMAdapter', side_effect=simulated), contextlib.redirect_stdout(captured):
                status = glm.main(['--input', str(source), '--config', str(config), '--output', str(output), '--execute'])
            self.assertEqual(status, 1); self.assertEqual(json.loads(captured.getvalue())['error'], 'credential_reflection_detected')
            text = output.read_text(); row = json.loads(text)
            self.assertIsNone(row['answer']); self.assertNotIn(encoded, text); self.assertNotIn(glm.SIMULATION_CREDENTIAL, text)

    def test_two_simultaneous_admissions_cannot_exceed_any_cumulative_cap(self):
        for gate in ('cost', 'calls', 'bytes', 'output', 'input_tokens'):
            config = guarded(); expected = {'cost': 'cost_budget_exceeded', 'calls': 'call_budget_exceeded',
                                           'bytes': 'input_budget_exceeded', 'output': 'output_budget_exceeded',
                                           'input_tokens': 'total_input_token_budget_exceeded'}[gate]
            if gate == 'cost': config['spend_guard']['max_cost'] = 0.001124
            if gate == 'calls': config['max_calls'] = 1
            if gate == 'bytes': config['max_total_input_bytes'] = len(ds.prepare(ROW))
            if gate == 'output': config['max_total_output_tokens'] = 256
            if gate == 'input_tokens': config['spend_guard']['max_total_input_tokens'] = 50
            start, rejected = threading.Barrier(2), threading.Event()
            def transport(*args):
                self.assertTrue(rejected.wait(2), 'second admission must reject while the first is in flight')
                return response()
            adapter, fake = self.adapter(config, transport=Mock(side_effect=transport))
            def work():
                start.wait(timeout=2); result = adapter.complete(ROW)
                if result['status'] == 'error': rejected.set()
                return result
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                values = [future.result(timeout=3) for future in [executor.submit(work), executor.submit(work)]]
            self.assertEqual(sorted(v['status'] for v in values), ['error', 'ok'])
            self.assertEqual(next(v['error'] for v in values if v['status'] == 'error'), expected)
            self.assertEqual(fake.call_count, 1); self.assertEqual(adapter.calls, 1)
            self.assertEqual(adapter.reserved_cost, Decimal('0.001124'))
            self.assertEqual(adapter.complete(ROW)['error'], 'adapter_halted')

    def test_invalid_admission_publishes_halt_before_unlock_even_if_its_outer_handler_is_paused(self):
        failed, release = threading.Event(), threading.Event()
        class ExitGate:
            def __init__(self): self.lock = threading.Lock()
            def __enter__(self): self.lock.acquire(); return self
            def __exit__(self, kind, error, trace):
                self.lock.release()
                if error is not None and str(error) == 'invalid_input_fields':
                    failed.set()
                    if not release.wait(2): raise AssertionError('admission failure handler was not released')
        adapter, fake = self.adapter(); adapter.lock = ExitGate()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            invalid = executor.submit(adapter.complete, {**ROW, 'gold': 'synthetic forbidden field'})
            try:
                self.assertTrue(failed.wait(2))
                valid = executor.submit(adapter.complete, ROW).result(timeout=2)
                self.assertEqual(valid['error'], 'adapter_halted'); fake.assert_not_called()
                self.assertEqual(adapter.calls, 0)
            finally: release.set()
            self.assertEqual(invalid.result(timeout=2)['error'], 'invalid_input_fields')

    def test_glm_shared_policy_also_reserves_all_caps_atomically_for_module_callers(self):
        config = {'model': 'glm-test', 'max_calls': 1, 'max_input_bytes': 1024,
                  'max_request_bytes': 4096, 'max_response_bytes': 4096, 'max_total_input_bytes': 2048,
                  'max_output_tokens': 32, 'max_total_output_tokens': 32, 'timeout_seconds': 1,
                  'pricing': guarded()['pricing'], 'spend_guard': guarded()['spend_guard']}
        start, rejected = threading.Barrier(2), threading.Event()
        def transport(*args):
            self.assertTrue(rejected.wait(2))
            return {'status': 200, 'body': response()['body']}
        fake = Mock(side_effect=transport)
        adapter = glm.GLMAdapter(config, execute=True, simulation=True, transport=fake, token_counter=counter())
        def work():
            start.wait(timeout=2); result = adapter.complete(ROW)
            if result['status'] == 'error': rejected.set()
            return result
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            values = [future.result(timeout=3) for future in [executor.submit(work), executor.submit(work)]]
        self.assertEqual(sorted(v['status'] for v in values), ['error', 'ok'])
        self.assertEqual(next(v['error'] for v in values if v['status'] == 'error'), 'call_budget_exceeded')
        self.assertEqual(fake.call_count, 1); self.assertEqual(adapter.calls, 1)
        self.assertEqual(adapter.reserved_output_tokens, 32)

    def run_fixture(self, root, extra=(), **options):
        source = root / 'synthetic-input.jsonl'; output = root / 'synthetic-output'
        source.write_bytes(b''.join(ds.encode({**ROW, 'id': f'dev/synthetic/q{i}/no_memory', 'query': f'Synthetic question {i}'}) + b'\n' for i in range(4)))
        args = ['--input', str(source), '--output', str(output), '--split', 'dev', *extra]
        with patch.object(runner.subprocess, 'check_output', return_value='synthetic-offline-revision'), contextlib.redirect_stdout(io.StringIO()):
            status = runner.main(args, **options)
        return status, output

    def test_runner_dry_run_stays_usable_and_real_cli_preflight_creates_no_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); status, output = self.run_fixture(root)
            self.assertEqual(status, 0); rows = [json.loads(line) for line in (output / 'calls.jsonl').read_bytes().splitlines()]
            self.assertEqual([r['status'] for r in rows], ['dry_run'] * 4)
            self.assertEqual((output / 'calls.jsonl').stat().st_mode & 0o777, 0o600)
        for config, code in [(None, 'spend_guard_required'), (guarded(), 'token_counter_unavailable')]:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp); extra = ['--execute']
                if config:
                    path = root / 'budget.json'; path.write_bytes(ds.encode(config)); extra += ['--config', str(path)]
                with self.assertRaisesRegex(ds.AdapterError, code): self.run_fixture(root, extra)
                self.assertFalse((root / 'synthetic-output').exists())
        ds.read_credential.assert_not_called()

    def test_whole_run_cost_preflight_fails_before_files_or_simulated_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); config = guarded(); config['spend_guard']['max_cost'] = 0.002248
            path = root / 'budget.json'; path.write_bytes(ds.encode(config)); fake = Mock()
            with self.assertRaisesRegex(ds.AdapterError, 'cost_budget_exceeded'):
                self.run_fixture(root, ['--execute', '--config', str(path)], token_counter=counter(), simulation=True, transport_fn=fake)
            self.assertFalse((root / 'synthetic-output').exists()); fake.assert_not_called()

    def test_runner_retains_failed_inflight_pair_and_unexecuted_rows_without_retry(self):
        for missing_usage in (False, True):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp); barrier = threading.Barrier(2)
                def transport(body, key, timeout):
                    self.assertEqual(key, ds.SIMULATION_CREDENTIAL); barrier.wait(timeout=2)
                    if missing_usage: return response(usage=None)
                    query = json.loads(json.loads(body)['messages'][1]['content'])['query']
                    return {'error': 'http_error', 'http_status': 429} if query.endswith(' 0') else response()
                fake = Mock(side_effect=transport)
                status, output = self.run_fixture(root, ['--execute'], simulation=True, transport_fn=fake)
                self.assertEqual(status, 1); self.assertEqual(fake.call_count, 2)
                rows = [json.loads(line) for line in (output / 'calls.jsonl').read_bytes().splitlines()]
                self.assertEqual([r['attempts'] for r in rows], [1, 1, 0, 0])
                self.assertEqual([r['status'] for r in rows[2:]], ['not_run', 'not_run'])
                self.assertEqual(rows[0]['error'], 'usage_unverifiable' if missing_usage else 'http_error')
                self.assertEqual(json.loads((output / 'config.json').read_bytes())['execution_mode'], 'simulation')
                self.assertNotIn(ds.SIMULATION_CREDENTIAL, (output / 'calls.jsonl').read_text())


if __name__ == '__main__': unittest.main()
