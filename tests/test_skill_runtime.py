import copy
import unittest

from runtime.skill_runtime import SkillRuntime
from runtime.tool_runtime import InMemoryIdempotencyStore, ToolInvocationError, ToolRuntime


REQUEST = {
    "schema_version": "1.0",
    "run_id": "018f47d2-8c3a-7a41-9b10-8a11b12c13d4",
    "skill_id": "skill.lookup",
    "idempotency_key": "skill:lookup:request-0001",
    "input": {"query": "hello"},
}

PRINCIPAL = {
    "tenant_id": "tenant-a",
    "actor_id": "user-1",
    "scopes": {"lookup:read"},
}

TOOL_REGISTRY = {
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
                }
            },
        }
    }
}

SKILL_REGISTRY = {
    "skills": {
        "skill.lookup": {
            "status": "verified",
            "requires_tools": ["tool.example"],
            "requires_invocations": ["example.lookup"],
        }
    }
}

SKILL_DEFINITIONS = {
    "skill.lookup": {
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["query"],
            "properties": {"query": {"type": "string", "minLength": 1}},
        },
        "output_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["answer"],
            "properties": {"answer": {"type": "string"}},
        },
        "steps": [
            {
                "id": "lookup",
                "tool_id": "tool.example",
                "invocation_id": "example.lookup",
                "input_mapping": {"query": "input.query"},
            }
        ],
        "output_mapping": {"answer": "steps.lookup.result.answer"},
    }
}


class SkillRuntimeTests(unittest.TestCase):
    def make_runtime(self, *, skill_registry=None, tool_registry=None, handler=None, audit_sink=None):
        calls = []
        def default_handler(data, context):
            calls.append(data["query"])
            return {"answer": "result:" + data["query"]}
        tool_runtime = ToolRuntime(
            tool_registry or TOOL_REGISTRY,
            {("tool.example", "example.lookup"): handler or default_handler},
            idempotency_store=InMemoryIdempotencyStore(),
            audit_sink=lambda event: None,
        )
        runtime = SkillRuntime(
            tool_runtime,
            skill_registry or SKILL_REGISTRY,
            SKILL_DEFINITIONS,
            idempotency_store=InMemoryIdempotencyStore(),
            audit_sink=audit_sink or (lambda event: None),
        )
        return runtime, calls

    def test_runs_verified_skill_as_typed_sequential_tool_steps(self):
        runtime, calls = self.make_runtime()
        result = runtime.run(REQUEST, PRINCIPAL)
        self.assertEqual(result["result"], {"answer": "result:hello"})
        self.assertEqual(calls, ["hello"])
        self.assertEqual(result["status"], "succeeded")

    def test_rejects_proposed_skill(self):
        registry = copy.deepcopy(SKILL_REGISTRY)
        registry["skills"]["skill.lookup"]["status"] = "proposed"
        runtime, calls = self.make_runtime(skill_registry=registry)
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.run(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "SKILL_NOT_VERIFIED")
        self.assertEqual(calls, [])

    def test_preflights_all_tool_dependencies_before_first_step(self):
        tools = copy.deepcopy(TOOL_REGISTRY)
        tools["tools"]["tool.example"]["status"] = "discovered"
        runtime, calls = self.make_runtime(tool_registry=tools)
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.run(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "SKILL_DEPENDENCY_NOT_VERIFIED")
        self.assertEqual(calls, [])

    def test_skill_cannot_escalate_principal_scopes(self):
        runtime, calls = self.make_runtime()
        principal = {**PRINCIPAL, "scopes": set()}
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.run(REQUEST, principal)
        self.assertEqual(caught.exception.code, "INSUFFICIENT_SCOPE")
        self.assertEqual(calls, [])

    def test_skill_run_replay_does_not_repeat_tool_step(self):
        runtime, calls = self.make_runtime()
        first = runtime.run(REQUEST, PRINCIPAL)
        second = runtime.run(REQUEST, PRINCIPAL)
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(calls, ["hello"])

    def test_rejects_caller_supplied_tenant_or_scopes(self):
        runtime, calls = self.make_runtime()
        request = {**REQUEST, "tenant_id": "attacker", "scopes": ["admin"]}
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.run(request, PRINCIPAL)
        self.assertEqual(caught.exception.code, "INVALID_SKILL_REQUEST")
        self.assertEqual(calls, [])

    def test_audit_outage_blocks_skill_execution(self):
        calls = []
        def broken_audit(event):
            raise RuntimeError("audit unavailable")
        runtime, _ = self.make_runtime(audit_sink=broken_audit, handler=lambda data, context: calls.append(data))
        with self.assertRaises(ToolInvocationError) as caught:
            runtime.run(REQUEST, PRINCIPAL)
        self.assertEqual(caught.exception.code, "AUDIT_UNAVAILABLE")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
