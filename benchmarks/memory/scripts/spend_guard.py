"""Shared local accounting policy; no credentials, network or tokenizer loading.

Callers serialize check + reservation and keep the ledger for the whole run.
Configured rates and a matching tokenizer ID are not independent verification.
"""
from decimal import (Context, Decimal, DivisionByZero, InvalidOperation, Overflow,
                     ROUND_HALF_EVEN, localcontext)
import json
import math
import re

# Accepted prices/budgets are bounded finite Python ints/floats (down to
# 5e-324), rates <= 1e6, and request token counts <= 1e7. Even mixing a full
# budget with the smallest per-million charge needs fewer than 350 digits.
# 512 preserves these exact decimal sums without inheriting thread precision,
# rounding, exponent limits or traps. Callers must not enlarge those bounds.
_MONEY_CONTEXT = Context(prec=512, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999,
                         capitals=1, clamp=0, flags=[],
                         traps=[InvalidOperation, DivisionByZero, Overflow])

_ECHO_MAX_PARSES = 64
_ECHO_MAX_PARSE_BYTES = 16 * 1024 * 1024
_ECHO_MAX_TEXT_BYTES = 32 * 1024 * 1024
_ECHO_MAX_DEPTH = 32
_ECHO_MAX_NODES = 100000


class AdapterError(Exception):
    """Fixed safe codes only; never provider or transport exception text."""


def positive_int(value, maximum):
    return type(value) is int and 0 < value <= maximum


def validate_spend_config(config):
    pricing = config.get("pricing")
    if pricing is not None:
        if not isinstance(pricing, dict) or set(pricing) != {"currency", "input_per_million", "output_per_million"}:
            raise AdapterError("invalid_pricing")
        if not isinstance(pricing["currency"], str) or not re.fullmatch(r"[A-Z]{3}", pricing["currency"]):
            raise AdapterError("invalid_pricing")
        for field in ("input_per_million", "output_per_million"):
            value = pricing[field]
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1000000:
                raise AdapterError("invalid_pricing")
    guard = config.get("spend_guard")
    if guard is not None:
        if (not isinstance(guard, dict) or set(guard) != {
                "tokenizer_id", "max_input_tokens", "max_total_input_tokens", "max_cost"}
                or pricing is None):
            raise AdapterError("invalid_spend_guard")
        if (not isinstance(guard["tokenizer_id"], str)
                or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", guard["tokenizer_id"])
                or not positive_int(guard["max_input_tokens"], 10**7)
                or not positive_int(guard["max_total_input_tokens"], 10**11)):
            raise AdapterError("invalid_spend_guard")
        value = guard["max_cost"]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 10**6:
            raise AdapterError("invalid_spend_guard")


def reserve_spend(state, body):
    """Reserve the full prompt + output cap. Caller holds its admission lock."""
    guard = state.config.get("spend_guard")
    if guard is None:
        return None
    if (not callable(state.token_counter)
            or getattr(state.token_counter, "tokenizer_id", None) != guard["tokenizer_id"]):
        raise AdapterError("token_counter_unavailable")
    count = state.token_counter(body)
    if not positive_int(count, 10**7):
        raise AdapterError("invalid_token_count")
    if count > guard["max_input_tokens"]:
        raise AdapterError("input_token_budget_exceeded")
    if state.reserved_input_tokens + count > guard["max_total_input_tokens"]:
        raise AdapterError("total_input_token_budget_exceeded")
    pricing = state.config["pricing"]
    with localcontext(_MONEY_CONTEXT):
        cost = configured_cost(count, state.config["max_output_tokens"], pricing)
        cumulative = state.reserved_cost + cost
        if cumulative > Decimal(str(guard["max_cost"])):
            raise AdapterError("cost_budget_exceeded")
    state.reserved_input_tokens += count
    state.reserved_cost = cumulative
    return {"tokenizer_id": guard["tokenizer_id"], "input_tokens": count,
            "cumulative_input_tokens": state.reserved_input_tokens,
            "currency": pricing["currency"], "request_cost_reservation": str(cost),
            "cumulative_cost_reservation": str(state.reserved_cost),
            "basis": "verified_tokenizer_and_configured_rates_required_not_invoice"}


def configured_cost(input_tokens, output_tokens, pricing):
    """Exact configured flat-rate amount, not a provider invoice or cache rate."""
    with localcontext(_MONEY_CONTEXT):
        return (Decimal(input_tokens) * Decimal(str(pricing['input_per_million']))
                + Decimal(output_tokens) * Decimal(str(pricing['output_per_million']))) / Decimal(10**6)


def reject_credential_reflection(data, credential):
    """Scan decoded provider data and bounded valid JSON strings, unchanged.

    In particular message.content is itself an answer JSON string. Preserve
    every inner key/value pair so duplicate keys cannot hide an encoded echo.
    This is not a decoder for arbitrary encodings or transformations.
    """
    if not credential:
        return
    pending = [(data, 0)]
    parses = parse_bytes = text_bytes = nodes = 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if depth > _ECHO_MAX_DEPTH or nodes > _ECHO_MAX_NODES:
            raise AdapterError('credential_scan_limit_exceeded')
        if isinstance(value, str):
            size = len(value.encode('utf-8'))
            text_bytes += size
            if text_bytes > _ECHO_MAX_TEXT_BYTES:
                raise AdapterError('credential_scan_limit_exceeded')
            if credential in value:
                raise AdapterError("credential_reflection_detected")
            candidate = value.lstrip()
            if candidate and candidate[0] in '{["':
                parses += 1
                parse_bytes += size
                if parses > _ECHO_MAX_PARSES or parse_bytes > _ECHO_MAX_PARSE_BYTES:
                    raise AdapterError('credential_scan_limit_exceeded')
                try:
                    decoded = json.loads(value, object_pairs_hook=lambda pairs: pairs)
                except json.JSONDecodeError:
                    continue
                except RecursionError:
                    raise AdapterError('credential_scan_limit_exceeded') from None
                pending.append((decoded, depth + 1))
        if isinstance(value, dict):
            if nodes + len(pending) + 2 * len(value) > _ECHO_MAX_NODES:
                raise AdapterError('credential_scan_limit_exceeded')
            pending.extend((item, depth + 1) for pair in value.items() for item in pair)
        elif isinstance(value, (list, tuple)):
            if nodes + len(pending) + len(value) > _ECHO_MAX_NODES:
                raise AdapterError('credential_scan_limit_exceeded')
            pending.extend((item, depth + 1) for item in value)


def parse_usage(raw, *, flat_cache=False):
    details = {"cached_tokens": None, "reasoning_tokens": None}
    if raw is None:
        return None, details
    if not isinstance(raw, dict):
        raise AdapterError("invalid_response")
    fields = ["prompt_tokens", "completion_tokens", "total_tokens"]
    if flat_cache:
        fields += ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]
    usage = {key: raw.get(key) for key in fields}
    if any(v is not None and (type(v) is not int or not 0 <= v <= 10**12) for v in usage.values()):
        raise AdapterError("invalid_response")
    for parent, key, total in [("prompt_tokens_details", "cached_tokens", "prompt_tokens"),
                               ("completion_tokens_details", "reasoning_tokens", "completion_tokens")]:
        nested = raw.get(parent)
        if nested is not None:
            if not isinstance(nested, dict):
                raise AdapterError("invalid_response")
            value = nested.get(key)
            if value is not None:
                if type(value) is not int or not 0 <= value <= 10**12:
                    raise AdapterError("invalid_response")
                if type(usage.get(total)) is int and value > usage[total]:
                    raise AdapterError("invalid_response")
            details[key] = value
    if flat_cache:
        hit, miss, prompt = (usage[k] for k in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "prompt_tokens"))
        if prompt is not None and (any(v is not None and v > prompt for v in (hit, miss))
                                   or (hit is not None and miss is not None and hit + miss != prompt)):
            raise AdapterError("invalid_response")
        if hit is not None:
            if details["cached_tokens"] is not None and details["cached_tokens"] != hit:
                raise AdapterError("invalid_response")
            details["cached_tokens"] = hit
    return usage, details


def require_usage(usage):
    fields = ("prompt_tokens", "completion_tokens", "total_tokens")
    if (usage is None or any(usage.get(k) is None for k in fields)
            or usage["prompt_tokens"] + usage["completion_tokens"] != usage["total_tokens"]):
        raise AdapterError("usage_unverifiable")
