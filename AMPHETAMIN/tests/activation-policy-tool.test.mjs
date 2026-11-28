import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const identity = {
  access: {
    getIdentity: async () => ({
      email: "owner@example.invalid",
      id: "access-owner-activation-test"
    })
  }
};
const TELEMETRY = {
  backlog: 14,
  ambiguous_tasks: 2,
  resource_pressure: 45,
  overload_score: 30,
  quality_score: 92,
  cooldown_latched: 0,
  recovery_score: 80,
  integrity_risk: 0,
  available_credits: 900,
  max_credits: 1200,
  max_workers: 8
};
const envFor = (fetch) => ({
  COMPUTE_TENANT_ID: "symbiotyc",
  COMPUTE_PROJECT_ID: "compute",
  RUNTIME_DB: new FakeD1(),
  GROUP: { fetch }
});
const rpc = (method, params = {}, id = 77) => new Request("https://amphetamin.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
});
const decodePrincipal = request => JSON.parse(
  Buffer.from(request.headers.get("x-symbiotyc-principal"), "base64url").toString("utf8")
);

test("advertises the activation policy evaluator as a compute-only MCP tool", async () => {
  const payload = await (await handleRequest(
    rpc("tools/list"), envFor(async () => Response.json({})), identity
  )).json();
  const tool = payload.result.tools.find(item => item.name === "compute_activation_evaluate");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, Object.keys(TELEMETRY));
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test("evaluates telemetry through the private GROUP binding with a service principal narrowed to one scope", async () => {
  let captured;
  const env = envFor(async request => {
    captured = request;
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/activation/evaluate");
    assert.deepEqual(await request.json(), TELEMETRY);
    return Response.json({
      mode: 1,
      worker_count: 3,
      request_refill: 0,
      request_capacity: 0,
      reason_code: 0,
      activation_remaining_minutes: 30,
      drive_multiplier_percent: 100,
      projected_burnout_score: 12
    });
  });
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: TELEMETRY
  }), env, identity)).json();

  const principal = decodePrincipal(captured);
  assert.equal(captured.headers.get("x-symbiotyc-caller"), "amphetamin");
  assert.equal(principal.kind, "service");
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.match(principal.actor_id, /^access:[a-f0-9]{64}$/);
  assert.deepEqual(principal.scopes, ["compute:activation:evaluate"]);
  assert.equal(payload.result.isError, false);
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.status_code, 200);
  assert.equal(result.body.worker_count, 3);
  assert.equal(env.RUNTIME_DB.idempotency.size, 2);
});

test("rejects caller-supplied randomness and unknown telemetry before invoking GROUP", async () => {
  let called = false;
  const env = envFor(async () => { called = true; return Response.json({}); });
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: { ...TELEMETRY, random_u32: 123 }
  }), env, identity)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /INVALID_SKILL_INPUT/);
});

test("fails closed when the GROUP service binding is unavailable", async () => {
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: TELEMETRY
  }), { ...envFor(async () => Response.json({})), GROUP: undefined }, identity)).json();
  assert.equal(payload.result.isError, true);
});

test("does not advertise or invoke job dispatch as part of policy evaluation", async () => {
  let path;
  const env = envFor(async request => {
    path = new URL(request.url).pathname;
    return Response.json({ mode: 1, worker_count: 2 });
  });
  const listed = await (await handleRequest(rpc("tools/list"), env, identity)).json();
  const names = listed.result.tools.map(item => item.name);
  assert.equal(names.includes("compute_submit_job"), false);
  assert.equal(names.includes("compute_cancel_job"), false);
  await handleRequest(rpc("tools/call", {
    name: "compute_activation_evaluate", arguments: TELEMETRY
  }), env, identity);
  assert.equal(path, "/v1/activation/evaluate");
});
