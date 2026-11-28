import test from "node:test";
import assert from "node:assert/strict";
import { ToolRuntime, ToolInvocationError } from "../runtime/tool-runtime.mjs";
import { SkillRuntime } from "../runtime/skill-runtime.mjs";
import { TOOL_REGISTRY, SKILL_REGISTRY, SKILL_DEFINITIONS } from "../runtime/registry.mjs";

const uuid = () => crypto.randomUUID();
const principal = { tenant_id: "tenant-test", actor_id: "actor-test", scopes: ["compute:read"] };
const health = { status: "ok", service: "symbiotyc-group-control-plane", protocol: "symbiotyc.compute.v1", dispatch_enabled: false };

class MemoryLedger {
  constructor() { this.records = new Map(); }
  key(key) { return `${key.tenant_id}:${key.idempotency_key}`; }
  async claim(key, hash) {
    const k = this.key(key), existing = this.records.get(k);
    if (!existing) { this.records.set(k, { hash, status: "in_progress", result: null }); return { state: "claimed" }; }
    if (existing.hash !== hash) { const e = new Error("idempotency key conflict"); e.code = "IDEMPOTENCY_KEY_REUSED"; throw e; }
    if (existing.status === "succeeded") return { state: "replay", result: existing.result };
    const e = new Error("not replayable"); e.code = existing.status === "unknown" ? "OUTCOME_UNKNOWN" : "INVOCATION_IN_PROGRESS"; throw e;
  }
  async finish(key, status, result = null) {
    const record = this.records.get(this.key(key));
    if (!record) throw new Error("missing ledger record");
    record.status = status;
    record.result = result;
  }
}

function makeToolRuntime({ handler, registry = TOOL_REGISTRY, audit = async () => {}, ledger = new MemoryLedger(), approvalVerifier = null } = {}) {
  const calls = { count: 0 };
  const handlers = handler ? { "symbiotyc.group:health": async (...args) => { calls.count++; return handler(...args); } } : {
    "symbiotyc.group:health": async () => { calls.count++; return health; }
  };
  const runtime = new ToolRuntime(registry, handlers, { idempotencyStore: ledger, approvalVerifier, auditSink: audit });
  return { runtime, calls, ledger };
}

function toolRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    request_id: uuid(),
    tool_id: "symbiotyc.group",
    invocation_id: "health",
    idempotency_key: "mcp:actor:request:0001",
    input: {},
    ...overrides
  };
}

function skillRequest(overrides = {}) {
  return {
    schema_version: "1.0",
    run_id: uuid(),
    skill_id: "skill.symbiotyc.group-health",
    idempotency_key: "mcp:actor:skill:0001",
    input: {},
    ...overrides
  };
}

test("ToolRuntime invokes only the verified read-only handler and emits durable audit events", async () => {
  const events = [];
  const { runtime, calls } = makeToolRuntime({ audit: async (event) => events.push(event) });
  const result = await runtime.invoke(toolRequest(), principal);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.result, health);
  assert.equal(result.replayed, false);
  assert.equal(calls.count, 1);
  assert.deepEqual(events.map((event) => event.status), ["requested", "started", "succeeded"]);
});

test("ToolRuntime replays same idempotency key without invoking the handler twice", async () => {
  const { runtime, calls } = makeToolRuntime();
  const request = toolRequest();
  const first = await runtime.invoke(request, principal);
  const second = await runtime.invoke({ ...request, request_id: uuid() }, principal);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, health);
  assert.equal(calls.count, 1);
});

test("ToolRuntime rejects caller-supplied identity and insufficient scopes", async () => {
  const { runtime } = makeToolRuntime();
  await assert.rejects(() => runtime.invoke(toolRequest({ tenant_id: "spoofed" }), principal), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => runtime.invoke(toolRequest(), { ...principal, scopes: [] }), (error) => error.code === "INSUFFICIENT_SCOPE");
});

test("ToolRuntime blocks unverified tools and missing trusted adapters", async () => {
  const unverified = { tools: { "symbiotyc.group": { status: "discovered", invocations: { health: { status: "verified", side_effect: "read", required_scopes: [], input_schema: { type: "object" } } } } } };
  const a = makeToolRuntime({ registry: unverified });
  await assert.rejects(() => a.runtime.invoke(toolRequest(), principal), (error) => error.code === "TOOL_NOT_VERIFIED");
  const b = new ToolRuntime(TOOL_REGISTRY, {}, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  await assert.rejects(() => b.invoke(toolRequest(), principal), (error) => error.code === "ADAPTER_NOT_CONFIGURED");
});

test("ToolRuntime requires approval for state-changing invocations", async () => {
  const registry = { tools: { "symbiotyc.group": { status: "verified", invocations: { write: { status: "verified", side_effect: "write", required_scopes: ["compute:write"], input_schema: { type: "object", properties: {}, additionalProperties: false } } } } } };
  const runtime = new ToolRuntime(registry, { "symbiotyc.group:write": async () => ({ ok: true }) }, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  const request = toolRequest({ invocation_id: "write", input: {}, idempotency_key: "mcp:actor:write:0001" });
  await assert.rejects(() => runtime.invoke(request, { ...principal, scopes: ["compute:write"] }), (error) => error.code === "APPROVAL_REQUIRED");
});

test("ToolRuntime blocks execution when durable audit is unavailable", async () => {
  const { runtime, calls } = makeToolRuntime({ audit: async () => { throw new Error("D1 unavailable"); } });
  await assert.rejects(() => runtime.invoke(toolRequest(), principal), (error) => error.code === "AUDIT_UNAVAILABLE");
  assert.equal(calls.count, 0);
});

test("ToolRuntime quarantines unknown handler outcomes", async () => {
  const ledger = new MemoryLedger();
  const { runtime } = makeToolRuntime({ ledger, handler: async () => { throw new Error("timeout after request"); } });
  const request = toolRequest();
  await assert.rejects(() => runtime.invoke(request, principal), (error) => error.code === "OUTCOME_UNKNOWN");
  const record = ledger.records.get(`tenant-test:${request.idempotency_key}`);
  assert.equal(record.status, "unknown");
  await assert.rejects(() => runtime.invoke(request, principal), (error) => error.code === "OUTCOME_UNKNOWN");
});

test("SkillRuntime composes a verified Skill through ToolRuntime", async () => {
  const events = [];
  const tool = makeToolRuntime({ audit: async (event) => events.push({ ...event, layer: "tool" }) });
  const skillLedger = new MemoryLedger();
  const skill = new SkillRuntime(tool.runtime, SKILL_REGISTRY, SKILL_DEFINITIONS, {
    idempotencyStore: skillLedger,
    auditSink: async (event) => events.push({ ...event, layer: "skill" })
  });
  const result = await skill.run(skillRequest(), principal);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.result, health);
  assert.equal(tool.calls.count, 1);
  assert.ok(events.some((event) => event.layer === "tool" && event.status === "succeeded"));
  assert.ok(events.some((event) => event.layer === "skill" && event.status === "succeeded"));
});

test("SkillRuntime preflights every dependency before invoking the first step", async () => {
  const registry = { tools: { "symbiotyc.group": { status: "discovered", invocations: { health: { status: "verified", side_effect: "read", required_scopes: ["compute:read"], input_schema: { type: "object", properties: {}, additionalProperties: false } } } } } };
  const tool = makeToolRuntime({ registry });
  const skill = new SkillRuntime(tool.runtime, SKILL_REGISTRY, SKILL_DEFINITIONS, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  await assert.rejects(() => skill.run(skillRequest(), principal), (error) => error.code === "SKILL_DEPENDENCY_NOT_VERIFIED");
  assert.equal(tool.calls.count, 0);
});

test("SkillRuntime does not broaden the principal scopes", async () => {
  const tool = makeToolRuntime();
  const skill = new SkillRuntime(tool.runtime, SKILL_REGISTRY, SKILL_DEFINITIONS, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  await assert.rejects(() => skill.run(skillRequest(), { ...principal, scopes: [] }), (error) => error.code === "INSUFFICIENT_SCOPE");
  assert.equal(tool.calls.count, 0);
});

test("SkillRuntime rejects unsafe and undeclared mapping paths before execution", async () => {
  const tool = makeToolRuntime();
  const badDefinition = {
    ...SKILL_DEFINITIONS,
    "skill.symbiotyc.group-health": {
      ...SKILL_DEFINITIONS["skill.symbiotyc.group-health"],
      steps: [{ ...SKILL_DEFINITIONS["skill.symbiotyc.group-health"].steps[0], input_mapping: { secret: "input.__proto__.secret" } }]
    }
  };
  const skill = new SkillRuntime(tool.runtime, SKILL_REGISTRY, badDefinition, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  await assert.rejects(() => skill.run(skillRequest(), principal), (error) => error.code === "INVALID_SKILL_DEFINITION");
  assert.equal(tool.calls.count, 0);
});

test("SkillRuntime replays completed runs without re-running steps", async () => {
  const tool = makeToolRuntime();
  const skill = new SkillRuntime(tool.runtime, SKILL_REGISTRY, SKILL_DEFINITIONS, { idempotencyStore: new MemoryLedger(), auditSink: async () => {} });
  const request = skillRequest();
  const first = await skill.run(request, principal);
  const second = await skill.run({ ...request, run_id: uuid() }, principal);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(tool.calls.count, 1);
});
