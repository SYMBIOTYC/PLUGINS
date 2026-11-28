import { validateSchema, assertSchemaSupported, SchemaValidationError } from "./schema-validator.mjs";
import { SKILL_RUN_REQUEST_SCHEMA } from "./schemas.mjs";
import { ToolInvocationError } from "./tool-runtime.mjs";

const STEP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError("undefined object property");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("value is not canonical JSON");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertPrincipal(principal) {
  if (
    !principal || typeof principal !== "object" ||
    typeof principal.tenant_id !== "string" || !principal.tenant_id.trim() ||
    typeof principal.actor_id !== "string" || !principal.actor_id.trim() ||
    !Array.isArray(principal.scopes) || !principal.scopes.every((scope) => typeof scope === "string")
  ) {
    throw new ToolInvocationError("INVALID_PRINCIPAL", "trusted tenant, actor and scopes are required", 401);
  }
  return { tenant_id: principal.tenant_id, actor_id: principal.actor_id, scopes: principal.scopes };
}

function validateMappingPath(path, previousStepIds, allowAnyStep = false) {
  if (typeof path !== "string" || path.length < 7 || path.length > 512) {
    throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill mapping path is invalid", 500);
  }
  const segments = path.split(".");
  if (segments.some((segment) => !segment || FORBIDDEN_SEGMENTS.has(segment))) {
    throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill mapping path contains an invalid segment", 500);
  }
  if (segments[0] === "input" && segments.length >= 2) return;
  if (segments[0] === "steps" && segments.length >= 4 && segments[2] === "result") {
    if (allowAnyStep || previousStepIds.has(segments[1])) return;
  }
  throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill mappings may reference only input fields or completed step results", 500);
}

function resolvePath(path, context) {
  let current = context;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new ToolInvocationError("SKILL_MAPPING_FAILED", "skill mapping source is unavailable", 422);
    }
    current = current[segment];
  }
  return current;
}

function operationDeclared(skill, toolId, invocationId) {
  if (Array.isArray(skill.invocation_sets)) {
    return skill.invocation_sets.some((set) => set?.tool === toolId && Array.isArray(set.invocations) && set.invocations.includes(invocationId));
  }
  return Array.isArray(skill.requires_tools) && skill.requires_tools.includes(toolId) &&
    Array.isArray(skill.requires_invocations) && skill.requires_invocations.includes(invocationId);
}

export class SkillRuntime {
  constructor(toolRuntime, skillRegistry, definitions, { idempotencyStore, auditSink } = {}) {
    if (!toolRuntime || typeof toolRuntime.invoke !== "function") throw new TypeError("ToolRuntime is required");
    if (!idempotencyStore || typeof idempotencyStore.claim !== "function" || typeof idempotencyStore.finish !== "function") {
      throw new TypeError("a durable skill idempotency store must be supplied");
    }
    if (typeof auditSink !== "function") throw new TypeError("a durable skill audit sink must be supplied");
    this.toolRuntime = toolRuntime;
    this.skillRegistry = skillRegistry;
    this.definitions = definitions || {};
    this.idempotencyStore = idempotencyStore;
    this.auditSink = auditSink;
  }

  async emitAudit(event) {
    try { await this.auditSink(event); }
    catch { throw new ToolInvocationError("AUDIT_UNAVAILABLE", "skill audit sink unavailable; execution is blocked", 503); }
  }

  preflight(skill, definition) {
    const steps = definition.steps;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32) {
      throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill must define 1 to 32 sequential steps", 500);
    }
    const seen = new Set();
    const prepared = [];
    for (const step of steps) {
      if (
        !step || typeof step !== "object" ||
        typeof step.id !== "string" || !STEP_ID.test(step.id) || seen.has(step.id) ||
        typeof step.tool_id !== "string" || typeof step.invocation_id !== "string" ||
        !step.input_mapping || typeof step.input_mapping !== "object" || Array.isArray(step.input_mapping) ||
        !Object.entries(step.input_mapping).every(([key, value]) => typeof key === "string" && typeof value === "string")
      ) {
        throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill step identity or mapping is invalid", 500);
      }
      for (const source of Object.values(step.input_mapping)) validateMappingPath(source, seen);
      if (!operationDeclared(skill, step.tool_id, step.invocation_id)) {
        throw new ToolInvocationError("SKILL_OPERATION_NOT_DECLARED", "skill step is outside its declared Tool/Invocation set", 403);
      }
      const tool = this.toolRuntime.registry?.tools?.[step.tool_id];
      const invocation = tool?.invocations?.[step.invocation_id];
      if (tool?.status !== "verified" || invocation?.status !== "verified") {
        throw new ToolInvocationError("SKILL_DEPENDENCY_NOT_VERIFIED", "all Tool and Invocation dependencies must be verified before a Skill starts", 409);
      }
      if (!this.toolRuntime.handlers?.has(`${step.tool_id}:${step.invocation_id}`)) {
        throw new ToolInvocationError("ADAPTER_NOT_CONFIGURED", "a trusted adapter is missing from the Skill dependency graph", 503);
      }
      seen.add(step.id);
      prepared.push(step);
    }
    return prepared;
  }

  async run(request, trustedPrincipal) {
    try { validateSchema(SKILL_RUN_REQUEST_SCHEMA, request); }
    catch (error) {
      if (error instanceof SchemaValidationError) throw new ToolInvocationError("INVALID_SKILL_REQUEST", "request does not match Skill Run v1 schema");
      throw error;
    }
    const principal = assertPrincipal(trustedPrincipal);
    const skill = this.skillRegistry?.skills?.[request.skill_id];
    if (!skill || skill.status !== "verified") throw new ToolInvocationError("SKILL_NOT_VERIFIED", "skill is not verified for execution", 403);
    const definition = this.definitions[request.skill_id];
    if (!definition || typeof definition !== "object") throw new ToolInvocationError("SKILL_DEFINITION_MISSING", "trusted skill definition is not configured", 503);

    try {
      assertSchemaSupported(definition.input_schema);
      assertSchemaSupported(definition.output_schema);
      validateSchema(definition.input_schema, request.input);
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        const code = error.path.startsWith("$schema") ? "INVALID_SKILL_DEFINITION" : "INVALID_SKILL_INPUT";
        throw new ToolInvocationError(code, code === "INVALID_SKILL_DEFINITION" ? "skill schema is invalid" : "skill input does not match its schema", code === "INVALID_SKILL_DEFINITION" ? 500 : 422);
      }
      throw error;
    }

    const steps = this.preflight(skill, definition);
    let requestHash;
    try {
      requestHash = await sha256(canonicalJson({
        skill_id: request.skill_id,
        tenant_id: principal.tenant_id,
        actor_id: principal.actor_id,
        input: request.input
      }));
    } catch {
      throw new ToolInvocationError("INVALID_SKILL_INPUT", "skill input is not canonical JSON", 422);
    }

    const ledgerKey = { tenant_id: principal.tenant_id, idempotency_key: request.idempotency_key };
    const event = (status) => ({
      event_type: "skill.run",
      run_id: request.run_id,
      skill_id: request.skill_id,
      tenant_id: principal.tenant_id,
      actor_id: principal.actor_id,
      request_hash: requestHash,
      step_count: steps.length,
      status
    });
    await this.emitAudit(event("requested"));
    let claim;
    try { claim = await this.idempotencyStore.claim(ledgerKey, requestHash); }
    catch (error) {
      if (error instanceof ToolInvocationError) throw error;
      if (error?.code) throw new ToolInvocationError(error.code, error.message, error.statusCode || 409);
      throw new ToolInvocationError("IDEMPOTENCY_UNAVAILABLE", "skill idempotency store unavailable; execution is blocked", 503);
    }
    if (claim.state === "replay") {
      await this.emitAudit(event("replayed"));
      return { run_id: request.run_id, skill_id: request.skill_id, status: "succeeded", result: claim.result, replayed: true };
    }
    try { await this.emitAudit(event("started")); }
    catch (error) {
      await this.idempotencyStore.finish(ledgerKey, "failed");
      throw error;
    }

    const context = { input: request.input, steps: {} };
    let attemptedSteps = 0;
    try {
      for (const step of steps) {
        const mappedInput = {};
        for (const [target, source] of Object.entries(step.input_mapping)) mappedInput[target] = resolvePath(source, context);
        const toolRequest = {
          schema_version: "1.0",
          request_id: crypto.randomUUID(),
          tool_id: step.tool_id,
          invocation_id: step.invocation_id,
          idempotency_key: `skillrun:${request.run_id}:${step.id}`,
          input: mappedInput
        };
        const approvalId = request.approvals?.[step.id];
        if (approvalId !== undefined) toolRequest.approval_id = approvalId;
        attemptedSteps += 1;
        context.steps[step.id] = await this.toolRuntime.invoke(toolRequest, principal);
      }

      const outputMapping = definition.output_mapping;
      if (!outputMapping || typeof outputMapping !== "object" || Array.isArray(outputMapping) ||
          !Object.entries(outputMapping).every(([key, value]) => typeof key === "string" && typeof value === "string")) {
        throw new ToolInvocationError("INVALID_SKILL_DEFINITION", "skill output mapping is invalid", 500);
      }
      const completedSteps = new Set(steps.map((step) => step.id));
      const result = {};
      for (const [target, source] of Object.entries(outputMapping)) {
        validateMappingPath(source, completedSteps, true);
        result[target] = resolvePath(source, context);
      }
      validateSchema(definition.output_schema, result);
      const safeResult = JSON.parse(JSON.stringify(result));
      await this.emitAudit(event("succeeded"));
      await this.idempotencyStore.finish(ledgerKey, "succeeded", safeResult);
      return { run_id: request.run_id, skill_id: request.skill_id, status: "succeeded", result: safeResult, replayed: false };
    } catch (error) {
      await this.idempotencyStore.finish(ledgerKey, attemptedSteps ? "unknown" : "failed");
      try { await this.emitAudit(event(attemptedSteps ? "outcome_unknown" : "failed")); } catch {}
      if (error instanceof ToolInvocationError) throw error;
      throw new ToolInvocationError(attemptedSteps ? "SKILL_OUTCOME_UNKNOWN" : "SKILL_FAILED", "skill execution failed; inspect step receipts before retry", attemptedSteps ? 502 : 422);
    }
  }
}
