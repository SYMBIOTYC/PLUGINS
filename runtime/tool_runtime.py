"""Fail-closed typed Tool Invocation Runtime v1.

This module is an in-process execution core, not an HTTP server. The host must
authenticate callers and supply a trusted principal before invoking it.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from jsonschema import Draft202012Validator, FormatChecker, ValidationError


_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contracts" / "tool-invocation-request-v1.schema.json"
_REQUEST_SCHEMA = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
Draft202012Validator.check_schema(_REQUEST_SCHEMA)
_REQUEST_VALIDATOR = Draft202012Validator(
    _REQUEST_SCHEMA,
    format_checker=FormatChecker(),
)

_STATE_CHANGING = {"write", "admin", "destructive"}


class ToolInvocationError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class InvocationContext:
    tenant_id: str
    actor_id: str
    request_id: str


class InMemoryIdempotencyStore:
    """Thread-safe development/test ledger. Not a production persistence backend."""

    def __init__(self):
        self._lock = threading.Lock()
        self._records = {}

    def claim(self, key: tuple[str, str], request_hash: str):
        with self._lock:
            existing = self._records.get(key)
            if existing is None:
                self._records[key] = {
                    "request_hash": request_hash,
                    "status": "in_progress",
                    "result": None,
                }
                return "claimed", None
            if existing["request_hash"] != request_hash:
                raise ToolInvocationError(
                    "IDEMPOTENCY_KEY_REUSED",
                    "idempotency key was already used with a different request",
                    409,
                )
            if existing["status"] == "succeeded":
                return "replay", existing["result"]
            if existing["status"] == "unknown":
                raise ToolInvocationError(
                    "OUTCOME_UNKNOWN",
                    "previous invocation outcome is unknown; reconcile before retry",
                    409,
                )
            if existing["status"] == "in_progress":
                raise ToolInvocationError(
                    "INVOCATION_IN_PROGRESS",
                    "an invocation with this idempotency key is already in progress",
                    409,
                )
            raise ToolInvocationError(
                "INVOCATION_NOT_RETRYABLE",
                "previous invocation is terminal and cannot be retried automatically",
                409,
            )

    def finish(self, key: tuple[str, str], status: str, result=None):
        if status not in {"succeeded", "unknown", "failed"}:
            raise ValueError("invalid idempotency state")
        with self._lock:
            record = self._records.get(key)
            if record is None:
                raise RuntimeError("idempotency claim does not exist")
            record["status"] = status
            record["result"] = result


class ToolRuntime:
    """Executes only server-registered handlers for verified tool operations.

    Registry data and handler mappings must be loaded from trusted deployment
    configuration/code. Never build handlers from catalog metadata or caller URLs.
    """

    def __init__(
        self,
        registry: Mapping,
        handlers: Mapping[tuple[str, str], Callable],
        *,
        idempotency_store,
        approval_verifier: Callable | None = None,
        audit_sink: Callable | None = None,
    ):
        self.registry = registry
        self.handlers = dict(handlers)
        self.idempotency_store = idempotency_store
        self.approval_verifier = approval_verifier
        self.audit_sink = audit_sink or (lambda event: None)

    @staticmethod
    def _canonical_hash(request: dict, principal: dict) -> str:
        normalized = {
            "tool_id": request["tool_id"],
            "invocation_id": request["invocation_id"],
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
    def _audit_event(request: dict, principal: dict, invocation: dict, request_hash: str, status: str):
        return {
            "event_type": "tool.invocation",
            "request_id": request["request_id"],
            "tool_id": request["tool_id"],
            "invocation_id": request["invocation_id"],
            "tenant_id": principal["tenant_id"],
            "actor_id": principal["actor_id"],
            "side_effect": invocation["side_effect"],
            "request_hash": request_hash,
            "status": status,
        }

    def invoke(self, request: dict, principal: dict) -> dict:
        if not isinstance(request, dict):
            raise ToolInvocationError("INVALID_REQUEST", "request must be an object")
        try:
            _REQUEST_VALIDATOR.validate(request)
        except ValidationError as exc:
            raise ToolInvocationError("INVALID_REQUEST", "request does not match Tool Invocation v1 schema") from exc

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
        ):
            raise ToolInvocationError("INVALID_PRINCIPAL", "trusted tenant, actor and scopes are required", 401)

        tool = self.registry.get("tools", {}).get(request["tool_id"])
        if not isinstance(tool, dict) or tool.get("status") != "verified":
            raise ToolInvocationError("TOOL_NOT_VERIFIED", "tool is not verified for invocation", 403)
        invocation = tool.get("invocations", {}).get(request["invocation_id"])
        if not isinstance(invocation, dict) or invocation.get("status") != "verified":
            raise ToolInvocationError("INVOCATION_NOT_VERIFIED", "invocation is not verified", 403)

        side_effect = invocation.get("side_effect")
        if side_effect not in {"read", "compute", "write", "admin", "destructive"}:
            raise ToolInvocationError("INVALID_REGISTRY", "invocation side-effect class is invalid", 500)
        required_scopes = invocation.get("required_scopes", [])
        if not isinstance(required_scopes, list) or not all(isinstance(scope, str) for scope in required_scopes):
            raise ToolInvocationError("INVALID_REGISTRY", "invocation scopes are invalid", 500)
        if not set(required_scopes).issubset(set(scopes)):
            raise ToolInvocationError("INSUFFICIENT_SCOPE", "principal lacks required invocation scopes", 403)

        input_schema = invocation.get("input_schema")
        if not isinstance(input_schema, dict):
            raise ToolInvocationError("INVALID_REGISTRY", "invocation input schema is missing", 500)
        try:
            Draft202012Validator.check_schema(input_schema)
            Draft202012Validator(input_schema).validate(request["input"])
        except (ValidationError, Exception) as exc:
            if isinstance(exc, ToolInvocationError):
                raise
            raise ToolInvocationError("INVALID_INPUT", "invocation input does not match its registered schema", 422) from exc

        handler = self.handlers.get((request["tool_id"], request["invocation_id"]))
        if not callable(handler):
            raise ToolInvocationError("ADAPTER_NOT_CONFIGURED", "no trusted adapter is registered for this operation", 503)

        request_hash = self._canonical_hash(request, principal)
        if side_effect in _STATE_CHANGING:
            approval_id = request.get("approval_id")
            claims = {
                "tenant_id": tenant_id,
                "actor_id": actor_id,
                "tool_id": request["tool_id"],
                "invocation_id": request["invocation_id"],
                "request_hash": request_hash,
                "side_effect": side_effect,
            }
            if (
                not approval_id
                or self.approval_verifier is None
                or not self.approval_verifier(approval_id, claims)
            ):
                raise ToolInvocationError("APPROVAL_REQUIRED", "a valid approval bound to this exact operation is required", 403)

        ledger_key = (tenant_id, request["idempotency_key"])
        self.audit_sink(self._audit_event(request, principal, invocation, request_hash, "requested"))
        state, prior_result = self.idempotency_store.claim(ledger_key, request_hash)
        if state == "replay":
            self.audit_sink(self._audit_event(request, principal, invocation, request_hash, "replayed"))
            return {
                "request_id": request["request_id"],
                "status": "succeeded",
                "result": prior_result,
                "replayed": True,
            }

        self.audit_sink(self._audit_event(request, principal, invocation, request_hash, "started"))
        context = InvocationContext(
            tenant_id=tenant_id,
            actor_id=actor_id,
            request_id=request["request_id"],
        )
        try:
            result = handler(request["input"], context)
            # Ensure persisted replay data is JSON-safe before marking success.
            encoded_result = json.dumps(result, ensure_ascii=False, allow_nan=False)
            safe_result = json.loads(encoded_result)
        except Exception as exc:
            self.idempotency_store.finish(ledger_key, "unknown")
            self.audit_sink(self._audit_event(request, principal, invocation, request_hash, "outcome_unknown"))
            raise ToolInvocationError(
                "OUTCOME_UNKNOWN",
                "adapter outcome is unknown; automatic retry is blocked pending reconciliation",
                502,
            ) from exc

        self.idempotency_store.finish(ledger_key, "succeeded", safe_result)
        self.audit_sink(self._audit_event(request, principal, invocation, request_hash, "succeeded"))
        return {
            "request_id": request["request_id"],
            "status": "succeeded",
            "result": safe_result,
            "replayed": False,
        }
