import { validateSchema, assertSchemaSupported, SchemaValidationError } from "./schema-validator.mjs";
import { TOOL_INVOCATION_REQUEST_SCHEMA } from "./schemas.mjs";

const STATE_CHANGING = new Set(["write", "admin", "destructive"]);
const SIDE_EFFECTS = new Set(["read", "compute", "write", "admin", "destructive"]);

export class ToolInvocationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ToolInvocationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (value[key] === undefined) throw new TypeError("undefined object property");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("value is not canonical JSON");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertPrincipal(principal) {
  const scopes = principal?.scopes;
  if (
    !principal || typeof principal !== "object" ||
    typeof principal.tenant_id !== "string" || !principal.tenant_id.trim() ||
    typeof principal.actor_id !== "string" || !principal.actor_id.trim() ||
    !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")
  ) {
    throw new ToolInvocationError("INVALID_PRINCIPAL", "trusted tenant, actor and scopes are required", 401);
  }
  return { tenant_id: principal.tenant_id, actor_id: principal.actor_id, scopes: new Set(scopes) };
}

export class ToolRuntime {
  constructor(registry, handlers, { idempotencyStore, approvalVerifier = null, auditSink } = {}) {
    if (!idempotencyStore || typeof idempotencyStore.claim !== "function" || typeof idempotencyStore.finish !== "function") {
      throw new TypeError("a durable idempotency store must be supplied");
    }
    if (typeof auditSink !== "function") throw new TypeError("a durable audit sink must be supplied");
    this.registry = registry;
    this.handlers = new Map(handlers instanceof Map ? handlers : Object.entries(handlers || {}));
    this.idempotencyStore = idempotencyStore;
    this.approvalVerifier = approvalVerifier;
    this.auditSink = auditSink;
  }

  async emitAudit(event) {
    try { await this.auditSink(event); }
    catch (error) {
      throw new ToolInvocationError("AUDIT_UNAVAILABLE", "audit sink unavailable; invocation is blocked", 503);
    }
  }

  async invoke(request, trustedPrincipal) {
    try { validateSchema(TOOL_INVOCATION_REQUEST_SCHEMA, request); }
    catch (error) {
      if (error instanceof SchemaValidationError) throw new ToolInvocationError("INVALID_REQUEST", "request does not match Tool Invocation v1 schema");
      throw error;
    }
    const principal = assertPrincipal(trustedPrincipal);
    const tool = this.registry?.tools?.[request.tool_id];
    if (!tool || tool.status !== "verified") throw new ToolInvocationError("TOOL_NOT_VERIFIED", "tool is not verified for invocation", 403);
    const invocation = tool.invocations?.[request.invocation_id];
    if (!invocation || invocation.status !== "verified") throw new ToolInvocationError("INVOCATION_NOT_VERIFIED", "invocation is not verified", 403);
    const sideEffect = invocation.side_effect;
    if (!SIDE_EFFECTS.has(sideEffect)) throw new ToolInvocationError("INVALID_REGISTRY", "invocation side-effect class is invalid", 500);
    const requiredScopes = invocation.required_scopes ?? [];
    if (!Array.isArray(requiredScopes) || !requiredScopes.every((scope) => typeof scope === "string")) {
      throw new ToolInvocationError("INVALID_REGISTRY", "invocation scopes are invalid", 500);
    }
    if (!requiredScopes.every((scope) => principal.scopes.has(scope))) {
      throw new ToolInvocationError("INSUFFICIENT_SCOPE", "principal lacks required invocation scopes", 403);
    }
    try {
      assertSchemaSupported(invocation.input_schema);
      validateSchema(invocation.input_schema, request.input);
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        const code = error.path.startsWith("$schema") ? "INVALID_REGISTRY" : "INVALID_INPUT";
        throw new ToolInvocationError(code, code === "INVALID_REGISTRY" ? "invocation input schema is invalid" : "invocation input does not match its registered schema", code === "INVALID_REGISTRY" ? 500 : 422);
      }
      throw error;
    }
    const handler = this.handlers.get(`${request.tool_id}:${request.invocation_id}`);
    if (typeof handler !== "function") throw new ToolInvocationError("ADAPTER_NOT_CONFIGURED", "no trusted adapter is registered for this operation", 503);

    let requestHash;
    try {
      const normalized = {
        tool_id: request.tool_id,
        invocation_id: request.invocation_id,
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        input: request.input
      };
      requestHash = await sha256(canonicalJson(normalized));
    } catch {
      throw new ToolInvocationError("INVALID_INPUT", "invocation input is not canonical JSON", 422);
    }

    if (STATE_CHANGING.has(sideEffect)) {
      const approvalId = request.approval_id;
      const claims = {
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        tool_id: request.tool_id,
        invocation_id: request.invocation_id,
        request_hash: requestHash,
        side_effect: sideEffect
      };
      if (!approvalId || typeof this.approvalVerifier !== "function") {
        throw new ToolInvocationError("APPROVAL_REQUIRED", "a valid approval bound to this exact operation is required", 403);
      }
      let approved = false;
      try { approved = await this.approvalVerifier(approvalId, claims); }
      catch { throw new ToolInvocationError("APPROVAL_VERIFICATION_FAILED", "approval service is unavailable", 503); }
      if (!approved) throw new ToolInvocationError("APPROVAL_REQUIRED", "approval does not match this exact operation", 403);
    }

    const ledgerKey = { tenant_id: principal.tenant_id, idempotency_key: request.idempotency_key };
    const event = (status) => ({
      event_type: "tool.invocation",
      request_id: request.request_id,
      tool_id: request.tool_id,
      invocation_id: request.invocation_id,
      tenant_id: principal.tenant_id,
      actor_id: principal.actor_id,
      side_effect: sideEffect,
      request_hash: requestHash,
      status
    });

    await this.emitAudit(event("requested"));
    let claim;
    try { claim = await this.idempotencyStore.claim(ledgerKey, requestHash); }
    catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      if (error?.code) throw new ToolInvocationError(error.code, error.message || "idempotency conflict", error.statusCode || 409);
      throw new ToolInvocationError("IDEMPOTENCY_UNAVAILABLE", "idempotency store unavailable; invocation is blocked", 503);
    }
    if (claim.state === "replay") {
      await this.emitAudit(event("replayed"));
      return { request_id: request.request_id, status: "succeeded", result: claim.result, replayed: true };
    }

    try { await this.emitAudit(event("started")); }
    catch (error) {
      await this.idempotencyStore.finish(ledgerKey, "failed");
      throw error;
    }

    let safeResult;
    try {
      const result = await handler(request.input, {
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        request_id: request.request_id
      });
      const encoded = JSON.stringify(result);
      if (encoded === undefined) throw new TypeError("handler returned a non-JSON result");
      safeResult = JSON.parse(encoded);
    } catch (error) {
      await this.idempotencyStore.finish(ledgerKey, "unknown");
      try { await this.emitAudit(event("outcome_unknown")); } catch {}
      throw new ToolInvocationError("OUTCOME_UNKNOWN", "adapter outcome is unknown; automatic retry is blocked pending reconciliation", 502);
    }

    try {
      await this.emitAudit(event("succeeded"));
      await this.idempotencyStore.finish(ledgerKey, "succeeded", safeResult);
    } catch {
      try { await this.idempotencyStore.finish(ledgerKey, "unknown"); } catch {}
      throw new ToolInvocationError("OUTCOME_UNKNOWN", "result was produced but durable completion could not be confirmed; reconcile before retry", 502);
    }
    return { request_id: request.request_id, status: "succeeded", result: safeResult, replayed: false };
  }
}
