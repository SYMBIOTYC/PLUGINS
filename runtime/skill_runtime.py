"""Fail-closed sequential Skill Runtime v1.

Skill definitions are trusted server-side data mappings. They are not prompts,
shell scripts, catalog instructions, or a source of additional permissions.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Mapping

from jsonschema import Draft202012Validator, FormatChecker, SchemaError, ValidationError

from .tool_runtime import ToolInvocationError


_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contracts" / "skill-run-request-v1.schema.json"
_REQUEST_SCHEMA = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(_REQUEST_SCHEMA)
_REQUEST_VALIDATOR = Draft202012Validator(_REQUEST_SCHEMA, format_checker=FormatChecker())
_STEP_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class SkillRuntime:
    """Composes verified Tool invocations into a sequential, auditable Skill run.

    The Skill registry, definitions, ToolRuntime, idempotency store and audit
    sink must be supplied by trusted host configuration. There is no dynamic
    code loading, shell execution, endpoint discovery, or scope escalation.
    """

    def __init__(
        self,
        tool_runtime,
        skill_registry: Mapping,
        definitions: Mapping,
        *,
        idempotency_store,
        audit_sink,
    ):
        if not callable(audit_sink):
            raise ValueError("a durable skill audit sink must be supplied")
        self.tool_runtime = tool_runtime
        self.skill_registry = skill_registry
        self.definitions = dict(definitions)
        self.idempotency_store = idempotency_store
        self.audit_sink = audit_sink

    def _emit_audit(self, event: dict) -> None:
        try:
            self.audit_sink(event)
        except Exception as exc:
            raise ToolInvocationError(
                "AUDIT_UNAVAILABLE",
                "skill audit sink unavailable; execution is blocked",
                503,
            ) from exc

    @staticmethod
    def _canonical_hash(request: dict, principal: dict) -> str:
        normalized = {
            "skill_id": request["skill_id"],
            "tenant_id": principal["tenant_id"],
            "actor_id": principal["actor_id"],
            "input": request["input"],
        }
        encoded = json.dumps(
            normalized,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _resolve_path(path: str, context: dict):
        if not isinstance(path, str) or not path or len(path) > 512:
            raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill mapping path is invalid", 500)
        current = context
        for segment in path.split("."):
            if not segment or not isinstance(current, dict) or segment not in current:
                raise ToolInvocationError("SKILL_MAPPING_FAILED", "skill mapping source is unavailable", 422)
            current = current[segment]
        return current

    @staticmethod
    def _operation_is_declared(skill: dict, tool_id: str, invocation_id: str) -> bool:
        if tool_id in skill.get("requires_tools", []) and invocation_id in skill.get("requires_invocations", []):
            return True
        for invocation_set in skill.get("invocation_sets", []):
            if (
                invocation_set.get("tool") == tool_id
                and invocation_id in invocation_set.get("invocations", [])
            ):
                return True
        return False

    def _preflight(self, skill: dict, definition: dict) -> list[dict]:
        steps = definition.get("steps")
        if not isinstance(steps, list) or not steps or len(steps) > 32:
            raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill must define 1 to 32 sequential steps", 500)

        tool_registry = self.tool_runtime.registry.get("tools", {})
        seen = set()
        prepared = []
        for step in steps:
            if not isinstance(step, dict):
                raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill step must be an object", 500)
            step_id = step.get("id")
            tool_id = step.get("tool_id")
            invocation_id = step.get("invocation_id")
            mapping = step.get("input_mapping")
            if (
                not isinstance(step_id, str)
                or not _STEP_ID.fullmatch(step_id)
                or step_id in seen
                or not isinstance(tool_id, str)
                or not isinstance(invocation_id, str)
                or not isinstance(mapping, dict)
                or not all(isinstance(key, str) and isinstance(value, str) for key, value in mapping.items())
            ):
                raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill step identity or mapping is invalid", 500)
            seen.add(step_id)

            if not self._operation_is_declared(skill, tool_id, invocation_id):
                raise ToolInvocationError("SKILL_OPERATION_NOT_DECLARED", "skill step is outside its declared Tool/Invocation set", 403)
            tool = tool_registry.get(tool_id)
            invocation = tool.get("invocations", {}).get(invocation_id) if isinstance(tool, dict) else None
            if (
                not isinstance(tool, dict)
                or tool.get("status") != "verified"
                or not isinstance(invocation, dict)
                or invocation.get("status") != "verified"
            ):
                raise ToolInvocationError(
                    "SKILL_DEPENDENCY_NOT_VERIFIED",
                    "all Tool and Invocation dependencies must be verified before a Skill starts",
                    409,
                )
            prepared.append(step)
        return prepared

    def run(self, request: dict, principal: dict) -> dict:
        if not isinstance(request, dict):
            raise ToolInvocationError("INVALID_SKILL_REQUEST", "skill request must be an object")
        try:
            _REQUEST_VALIDATOR.validate(request)
        except ValidationError as exc:
            raise ToolInvocationError("INVALID_SKILL_REQUEST", "request does not match Skill Run v1 schema") from exc

        if not isinstance(principal, dict):
            raise ToolInvocationError("INVALID_PRINCIPAL", "authenticated principal is required", 401)
        tenant_id = principal.get("tenant_id")
        actor_id = principal.get("actor_id")
        scopes = principal.get("scopes")
        if (
            not isinstance(tenant_id, str)
            or not tenant_id.strip()
            or not isinstance(actor_id, str)
            or not actor_id.strip()
            or not isinstance(scopes, (set, frozenset, list, tuple))
            or not all(isinstance(scope, str) for scope in scopes)
        ):
            raise ToolInvocationError("INVALID_PRINCIPAL", "trusted tenant, actor and scopes are required", 401)

        skill = self.skill_registry.get("skills", {}).get(request["skill_id"])
        if not isinstance(skill, dict) or skill.get("status") != "verified":
            raise ToolInvocationError("SKILL_NOT_VERIFIED", "skill is not verified for execution", 403)
        definition = self.definitions.get(request["skill_id"])
        if not isinstance(definition, dict):
            raise ToolInvocationError("SKILL_DEFINITION_MISSING", "trusted skill definition is not configured", 503)

        input_schema = definition.get("input_schema")
        output_schema = definition.get("output_schema")
        if not isinstance(input_schema, dict) or not isinstance(output_schema, dict):
            raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill input/output schemas are required", 500)
        try:
            Draft202012Validator.check_schema(input_schema)
            Draft202012Validator.check_schema(output_schema)
        except SchemaError as exc:
            raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill schema is invalid", 500) from exc
        try:
            Draft202012Validator(input_schema).validate(request["input"])
        except ValidationError as exc:
            raise ToolInvocationError("INVALID_SKILL_INPUT", "skill input does not match its schema", 422) from exc

        steps = self._preflight(skill, definition)
        try:
            request_hash = self._canonical_hash(request, principal)
        except (TypeError, ValueError) as exc:
            raise ToolInvocationError("INVALID_SKILL_INPUT", "skill input is not canonical JSON", 422) from exc

        ledger_key = (tenant_id, request["idempotency_key"])
        self._emit_audit({
            "event_type": "skill.run",
            "run_id": request["run_id"],
            "skill_id": request["skill_id"],
            "tenant_id": tenant_id,
            "actor_id": actor_id,
            "request_hash": request_hash,
            "step_count": len(steps),
            "status": "requested",
        })
        state, prior_result = self.idempotency_store.claim(ledger_key, request_hash)
        if state == "replay":
            self._emit_audit({
                "event_type": "skill.run",
                "run_id": request["run_id"],
                "skill_id": request["skill_id"],
                "tenant_id": tenant_id,
                "actor_id": actor_id,
                "request_hash": request_hash,
                "step_count": len(steps),
                "status": "replayed",
            })
            return {
                "run_id": request["run_id"],
                "skill_id": request["skill_id"],
                "status": "succeeded",
                "result": prior_result,
                "replayed": True,
            }

        try:
            self._emit_audit({
                "event_type": "skill.run",
                "run_id": request["run_id"],
                "skill_id": request["skill_id"],
                "tenant_id": tenant_id,
                "actor_id": actor_id,
                "request_hash": request_hash,
                "step_count": len(steps),
                "status": "started",
            })
        except ToolInvocationError:
            self.idempotency_store.finish(ledger_key, "failed")
            raise

        context = {"input": request["input"], "steps": {}}
        attempted_steps = 0
        try:
            for step in steps:
                mapped_input = {
                    target: self._resolve_path(source, context)
                    for target, source in step["input_mapping"].items()
                }
                tool_request = {
                    "schema_version": "1.0",
                    "request_id": str(uuid.uuid4()),
                    "tool_id": step["tool_id"],
                    "invocation_id": step["invocation_id"],
                    "idempotency_key": f"skillrun:{request['run_id']}:{step['id']}",
                    "input": mapped_input,
                }
                approval_id = request.get("approvals", {}).get(step["id"])
                if approval_id is not None:
                    tool_request["approval_id"] = approval_id

                attempted_steps += 1
                step_result = self.tool_runtime.invoke(tool_request, principal)
                context["steps"][step["id"]] = step_result

            output_mapping = definition.get("output_mapping")
            if (
                not isinstance(output_mapping, dict)
                or not all(isinstance(key, str) and isinstance(value, str) for key, value in output_mapping.items())
            ):
                raise ToolInvocationError("INVALID_SKILL_DEFINITION", "skill output mapping is invalid", 500)
            result = {
                target: self._resolve_path(source, context)
                for target, source in output_mapping.items()
            }
            Draft202012Validator(output_schema).validate(result)
            safe_result = json.loads(json.dumps(result, ensure_ascii=False, allow_nan=False))
        except Exception as exc:
            self.idempotency_store.finish(ledger_key, "unknown" if attempted_steps else "failed")
            self._emit_audit({
                "event_type": "skill.run",
                "run_id": request["run_id"],
                "skill_id": request["skill_id"],
                "tenant_id": tenant_id,
                "actor_id": actor_id,
                "request_hash": request_hash,
                "step_count": len(steps),
                "status": "outcome_unknown" if attempted_steps else "failed",
            })
            if isinstance(exc, ToolInvocationError):
                raise
            raise ToolInvocationError(
                "SKILL_OUTCOME_UNKNOWN" if attempted_steps else "SKILL_FAILED",
                "skill execution failed; inspect step receipts before retry",
                502 if attempted_steps else 422,
            ) from exc

        self.idempotency_store.finish(ledger_key, "succeeded", safe_result)
        self._emit_audit({
            "event_type": "skill.run",
            "run_id": request["run_id"],
            "skill_id": request["skill_id"],
            "tenant_id": tenant_id,
            "actor_id": actor_id,
            "request_hash": request_hash,
            "step_count": len(steps),
            "status": "succeeded",
        })
        return {
            "run_id": request["run_id"],
            "skill_id": request["skill_id"],
            "status": "succeeded",
            "result": safe_result,
            "replayed": False,
        }
