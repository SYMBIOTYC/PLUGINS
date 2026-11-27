import copy
import unittest

from runtime.tool_runtime import (
    InMemoryIdempotencyStore,
    ToolInvocationError,
    ToolRuntime,
)


REQUEST = {
    "schema_version": "1.0",
    "request_id": "018f47d2-8c3a-7a41-9b10-8a11b12c13d4",
    "tool_id": "tool.example",
    "invocation_id": "example.lookup",
    "idempotency_key": "example:lookup:request-0001",
    "input": {"query": "hello"},
}

PRINCIPAL = {
    "tenant_id": "tenant-a",
    "actor_id": "user-1",
    "scopes": {"lookup:read"},
}

VERIFIED_REGISTRY = {
    "tools": {
        "tool.example": {
            "status": "verified",
            "invocations": {
                "example.lookup": {
                    "status": "verified",
                    "side_effect": "read",
                    "required_scopes": ["lookup:read"],
                    "input_schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["query"],
                        "properties": {"query": {"type": "string", "minLength": 1}},
                    },
                },
                "example.write": {
                    "status": "verified",
                    "side_effect": "write",
                    "required_scopes": ["lookup:write"],
                    "input_schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["value"],
                        "properties": {"value": {"type": "string"}},
                    },
                },
            },
        }
    }
}


class ToolRuntimeTests(unittest.TestCase):
    def make_runtime(self, handler=None, registry=None, approval_verifier=None):
        handlers = {}
        if handler is not None:
            handlers[("tool.example", "example.lookup")] = handler
        handlers[("tool.example", "example.write")] = lambda data, context: {"saved": data["value"]}
        return ToolRuntime(
            registry or VERIFIED_REGISTRY,
            handlers,
            idempotency_store=InMemoryIdempotencyStore(),
            approval_verifier=approval_verifier,
            audit_sink=lambda event: None,
        )

    def test_constructor_requires_an_audit_sink(self):
        with self.assertRaises(ValueError):
            ToolRuntime(VERIFIED_REGISTRY, {}, idempotency_store=InMemoryIdempotencyStore())

    def test_audit_outage_blocks_handler_execution(self):
        calls = []
        def broken_audit(event):
            raise RuntimeError("audit storage unavailable")
        runtime = ToolRuntime(
            VERIFIED_REGISTRY,
            {("tool.example", "example.lookup"): lambda data, context: calls.append(data)},
            idempotency_store=InMemoryIdempotencyStore(),
            audit_sink=broken_audit,
        )
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.invoke(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "AUDIT_UNAVAILABLE")
        self.assertEqual(calls, [])

    def test_invokes_verified_handler_with_validated_input(self):
        seen = []
        runtime = self.make_runtime(lambda data, context: seen.append((data, context.tenant_id)) or {"ok": True})
        result = runtime.invoke(REQUEST, PRINCIPAL)
        self.assertEqual(result["result"], {"ok": True})
        self.assertEqual(seen, [({"query": "hello"}, "tenant-a")])

    def test_rejects_discovered_tool(self):
        registry = copy.deepcopy(VERIFIED_REGISTRY)
        registry["tools"]["tool.example"]["status"] = "discovered"
        with self.assertRaises(ToolInvocationError) as caught:
            self.make_runtime(registry=registry).invoke(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "TOOL_NOT_VERIFIED")

    def test_rejects_contract_only_invocation(self):
        registry = copy.deepcopy(VERIFIED_REGISTRY)
        registry["tools"]["tool.example"]["invocations"]["example.lookup"]["status"] = "contract_only"
        with self.assertRaises(ToolInvocationError) as caught:
            self.make_runtime(registry=registry).invoke(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "INVOCATION_NOT_VERIFIED")

    def test_rejects_missing_scope(self):
        principal = {**PRINCIPAL, "scopes": set()}
        with self.assertRaises(ToolInvocationError) as caught:
            self.make_runtime(lambda data, context: {}).invoke(REQUEST, principal)
        self.assertEqual(caught.exception.code, "INSUFFICIENT_SCOPE")

    def test_rejects_invalid_input_before_adapter(self):
        request = {**REQUEST, "input": {"query": 42}}
        calls = []
        with self.assertRaises(ToolInvocationError) as caught:
            self.make_runtime(lambda data, context: calls.append(data)).invoke(request, PRINCIPAL)
        self.assertEqual(caught.exception.code, "INVALID_INPUT")
        self.assertEqual(calls, [])

    def test_rejects_caller_supplied_authority_or_endpoint_fields(self):
        request = {**REQUEST, "tenant_id": "attacker", "adapter_url": "https://evil.invalid"}
        with self.assertRaises(ToolInvocationError) as caught:
            self.make_runtime(lambda data, context: {}).invoke(request, PRINCIPAL)
        self.assertEqual(caught.exception.code, "INVALID_REQUEST")

    def test_replays_success_without_running_side_effect_twice(self):
        calls = []
        runtime = self.make_runtime(lambda data, context: calls.append(data["query"]) or {"count": 1})
        first = runtime.invoke(REQUEST, PRINCIPAL)
        second = runtime.invoke(REQUEST, PRINCIPAL)
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(calls, ["hello"])

    def test_rejects_same_idempotency_key_with_different_payload(self):
        runtime = self.make_runtime(lambda data, context: {"ok": True})
        runtime.invoke(REQUEST, PRINCIPAL)
        changed = {**REQUEST, "input": {"query": "different"}}
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.invoke(changed, PRINCIPAL)
        self.assertEqual(caught.exception.code, "IDEMPOTENCY_KEY_REUSED")

    def test_requires_approval_for_write_invocations(self):
        request = {
            **REQUEST,
            "invocation_id": "example.write",
            "idempotency_key": "example:write:request-0001",
            "input": {"value": "important"},
        }
        principal = {**PRINCIPAL, "scopes": {"lookup:write"}}
        runtime = self.make_runtime()
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.invoke(request, principal)
        self.assertEqual(caught.exception.code, "APPROVAL_REQUIRED")

    def test_approval_is_bound_to_tenant_operation_and_request_hash(self):
        request = {
            **REQUEST,
            "invocation_id": "example.write",
            "idempotency_key": "example:write:request-0002",
            "approval_id": "approval-1",
            "input": {"value": "important"},
        }
        principal = {**PRINCIPAL, "scopes": {"lookup:write"}}
        approvals = []
        runtime = self.make_runtime(approval_verifier=lambda approval, claims: approvals.append((approval, claims)) or True)
        result = runtime.invoke(request, principal)
        self.assertEqual(result["result"], {"saved": "important"})
        self.assertEqual(approvals[0][0], "approval-1")
        self.assertEqual(approvals[0][1]["tenant_id"], "tenant-a")
        self.assertEqual(approvals[0][1]["tool_id"], "tool.example")
        self.assertEqual(approvals[0][1]["invocation_id"], "example.write")

    def test_unknown_handler_outcome_is_not_automatically_retried(self):
        calls = []
        def uncertain(data, context):
            calls.append(1)
            raise TimeoutError("provider outcome unknown")
        runtime = self.make_runtime(uncertain)
        with self.assertRaises(ToolInvocationError) as first:
            runtime.invoke(REQUEST, PRINCIPAL)
        self.assertEqual(first.exception.code, "OUTCOME_UNKNOWN")
        with self.assertRaises(ToolInvocationError) as second:
            runtime.invoke(REQUEST, PRINCIPAL)
        self.assertEqual(second.exception.code, "OUTCOME_UNKNOWN")
        self.assertEqual(calls, [1])

    def test_audit_does_not_include_input_or_result(self):
        events = []
        runtime = ToolRuntime(
            VERIFIED_REGISTRY,
            {("tool.example", "example.lookup"): lambda data, context: {"private": "result-secret"}},
            idempotency_store=InMemoryIdempotencyStore(),
            audit_sink=events.append,
        )
        runtime.invoke(REQUEST, PRINCIPAL)
        serialized = repr(events)
        self.assertNotIn("hello", serialized)
        self.assertNotIn("result-secret", serialized)
        self.assertEqual(events[0]["tool_id"], "tool.example")
        self.assertEqual(events[0]["tenant_id"], "tenant-a")


if __name__ == "__main__":
    unittest.main()
