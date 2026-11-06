"""Pre-request spend reservations; synthetic tokenizer and transport only."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_glm_adapter import config, response, ROW, glm


def guarded(**changes):
    guard = {"tokenizer_id": "synthetic-complete-chat-v1", "max_input_tokens": 60,
             "max_total_input_tokens": 100, "max_cost": 0.0005}
    guard.update(changes)
    return config(pricing={"currency": "CNY", "input_per_million": 2, "output_per_million": 4},
                  spend_guard=guard)


def counter(count=50):
    value = Mock(return_value=count)
    value.tokenizer_id = "synthetic-complete-chat-v1"
    return value


class SpendGuardTests(unittest.TestCase):
    def adapter(self, cfg=None, count=50, reply=None):
        transport = Mock(return_value=reply or response())
        tokens = counter(count)
        adapter = glm.GLMAdapter(cfg or guarded(), execute=True, transport=transport, token_counter=tokens, simulation=True)
        return adapter, transport, tokens

    def setUp(self):
        env = patch.dict(glm.os.environ, {"MEMZ_GLM_API_KEY": "synthetic-test-credential"}, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_exact_decimal_reservation_and_no_short_completion_refund(self):
        adapter, transport, tokens = self.adapter(guarded(max_cost=0.000456))
        first = adapter.complete(ROW)
        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["spend_reservation"]["request_cost_reservation"], "0.000228")
        request = json.loads(tokens.call_args.args[0])
        self.assertEqual(request["messages"][0]["content"], glm.SYSTEM_PROMPT)
        self.assertEqual(adapter.complete(ROW)["spend_reservation"]["cumulative_cost_reservation"], "0.000456")
        self.assertEqual(transport.call_count, 2)

    def test_cost_cap_blocks_next_request_before_credentials_and_transport(self):
        adapter, transport, _ = self.adapter(guarded(max_cost=0.0004559999))
        self.assertEqual(adapter.complete(ROW)["status"], "ok")
        with patch.object(glm.os.environ, "get", side_effect=AssertionError("no credential read")):
            result = adapter.complete(ROW)
        self.assertEqual(result["error"], "cost_budget_exceeded")
        self.assertEqual(result["attempts"], 0)
        self.assertEqual(adapter.complete(ROW)["error"], "adapter_halted")
        self.assertEqual(transport.call_count, 1)

    def test_per_call_and_total_input_token_caps(self):
        for cfg, first_status, error in [
                (guarded(max_input_tokens=49), "error", "input_token_budget_exceeded"),
                (guarded(max_total_input_tokens=99), "ok", "total_input_token_budget_exceeded")]:
            adapter, transport, _ = self.adapter(cfg)
            row = adapter.complete(ROW)
            self.assertEqual(row["status"], first_status)
            if first_status == "ok":
                row = adapter.complete(ROW)
            self.assertEqual(row["error"], error)
            self.assertEqual(transport.call_count, int(first_status == "ok"))

    def test_missing_mismatched_or_invalid_counter_never_reaches_transport(self):
        for token_counter in [None, Mock(), counter(True), counter(0), counter(-1), counter(1.5)]:
            transport = Mock()
            adapter = glm.GLMAdapter(guarded(), execute=True, transport=transport, token_counter=token_counter, simulation=True)
            with patch.object(glm.os.environ, "get", side_effect=AssertionError("no credential read")):
                result = adapter.complete(ROW)
            self.assertIn(result["error"], {"token_counter_unavailable", "invalid_token_count"})
            transport.assert_not_called()

    def test_provider_overrun_or_unknown_usage_stops_without_refund(self):
        for usage, error in [(None, "usage_unverifiable"),
                             ({"prompt_tokens": 51, "completion_tokens": 3, "total_tokens": 54},
                              "provider_input_budget_exceeded")]:
            adapter, transport, _ = self.adapter(reply=response(usage=usage))
            result = adapter.complete(ROW)
            self.assertEqual(result["error"], error)
            self.assertEqual(result["spend_reservation"]["cumulative_cost_reservation"], "0.000228")
            self.assertEqual(adapter.complete(ROW)["error"], "adapter_halted")
            self.assertEqual(transport.call_count, 1)

    def test_failed_http_attempt_keeps_full_reservation(self):
        adapter, transport, _ = self.adapter(reply={"status": 429, "body": b""})
        self.assertEqual(adapter.complete(ROW)["error"], "http_error")
        self.assertEqual(str(adapter.reserved_cost), "0.000228")
        self.assertEqual(adapter.reserved_input_tokens, 50)
        self.assertEqual(adapter.complete(ROW)["error"], "adapter_halted")
        self.assertEqual(transport.call_count, 1)

    def test_guard_configuration_requires_prices_and_finite_strict_limits(self):
        configs = [config(spend_guard=guarded()["spend_guard"])]
        for field, values in {"max_cost": [0, True, float("nan"), float("inf")],
                              "max_input_tokens": [0, True], "max_total_input_tokens": [-1],
                              "tokenizer_id": [None, "has spaces"]}.items():
            configs.extend(guarded(**{field: value}) for value in values)
        for cfg in configs:
            with self.subTest(cfg=cfg), self.assertRaises(glm.AdapterError):
                glm.GLMAdapter(cfg)

    def test_whole_file_preflight_catches_cumulative_cost_before_any_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "inputs.jsonl"
            path.write_bytes(glm.encode(ROW) + b"\n" + glm.encode({**ROW, "id": "other"}) + b"\n")
            with patch.object(glm.os.environ, "get", side_effect=AssertionError("no credential read")):
                with self.assertRaisesRegex(glm.AdapterError, "cost_budget_exceeded"):
                    glm.read_inputs(path, guarded(max_cost=0.0003), token_counter=counter())

    def test_production_python_entry_requires_guard_even_with_custom_transport(self):
        for transport in [None, Mock()]:
            with self.assertRaisesRegex(glm.AdapterError, "spend_guard_required"):
                glm.GLMAdapter(config(), execute=True, transport=transport)

    def test_simulation_is_explicit_marked_and_never_reads_real_credentials(self):
        for transport in [None, glm.http_transport]:
            with self.assertRaisesRegex(glm.AdapterError, "simulation_transport_required"):
                glm.GLMAdapter(config(), execute=True, simulation=True, transport=transport)
        with patch.object(glm.os.environ, "get", side_effect=AssertionError("no real secret reads")):
            adapter = glm.GLMAdapter(config(), execute=True, simulation=True, transport=Mock(return_value=response()))
            result = adapter.complete(ROW)
        self.assertEqual(result["execution_mode"], "simulation")
        self.assertEqual(result["status"], "ok")

    def test_cli_execute_fails_closed_without_a_verified_token_counter(self):
        for cfg in [config(), guarded()]:
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / "config.json").write_bytes(glm.encode(cfg))
                (root / "input.jsonl").write_bytes(glm.encode(ROW) + b"\n")
                captured = io.StringIO()
                with contextlib.redirect_stdout(captured), patch.object(glm, "http_transport") as transport:
                    status = glm.main(["--config", str(root / "config.json"), "--input", str(root / "input.jsonl"),
                                       "--output", str(root / "out.jsonl"), "--execute"])
                self.assertEqual(status, 1)
                self.assertEqual(json.loads(captured.getvalue())["error"],
                                 "token_counter_unavailable" if "spend_guard" in cfg else "spend_guard_required")
                self.assertFalse((root / "out.jsonl").exists())
                transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
