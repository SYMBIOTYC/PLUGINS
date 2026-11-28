import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.mjs";
import { callWithTestAccess } from "./access-fixture.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const identity = { access: { aud: "test-access-audience", getIdentity: async () => ({ email: "owner@example.invalid", id: "access-owner-1" }) } };
const telemetry = {
  backlog: 3,
  ambiguous_tasks: 0,
  resource_pressure: 0,
  overload_score: 0,
  quality_score: 100,
  cooldown_latched: 0,
  recovery_score: 0,
  integrity_risk: 0,
  available_credits: 10,
  max_credits: 10,
  max_workers: 4
};
const envFor = fetch => ({
  COMPUTE_TENANT_ID: "symbiotyc",
  COMPUTE_PROJECT_ID: "compute",
  RUNTIME_DB: new FakeD1(),
  GROUP: { fetch }
});
const rpc = (method, params = {}, id = 51) => new Request("https://amphetamin.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
});
const decodePrincipal = request => JSON.parse(
  Buffer.from(request.headers.get("x-symbiotyc-principal"), "base64url").toString("utf8")
);

test("MCP advertises policy evaluation with the exact bounded telemetry contract", async () => {
  const response = await callWithTestAccess(handleRequest, rpc("tools/list"), envFor(async () => Response.json({})), identity);
  const payload = await response.json();
  const tool = payload.result.tools.find(item => item.name === "compute_activation_evaluate");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, Object.keys(telemetry));
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, "random_u32"), false);
});

test("policy evaluation uses GROUP POST binding and a service principal with only evaluate scope", async () => {
  let capturedRequest;
  const env = envFor(async request => {
    capturedRequest = request;
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/v1/activation/evaluate");
    return Response.json({
      decision: {
        mode: 1,
        worker_count: 1,
        request_refill: 0,
        request_capacity: 0,
        reason_code: 5,
        activation_remaining_minutes: 240,
        drive_multiplier_percent: 130,
        projected_burnout_score: 45
      },
      activation_state: { version: 9, deployment_streak: 3, burnout_score: 45 }
    });
  });

  const payload = await (await callWithTestAccess(handleRequest, rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: telemetry
  }), env, identity)).json();

  assert.equal(payload.result.isError, false);
  assert.equal(capturedRequest.headers.get("x-symbiotyc-caller"), "amphetamin");
  assert.ok(capturedRequest.headers.get("content-type").includes("application/json"));
  assert.deepEqual(JSON.parse(await new Response(capturedRequest.body).text()), telemetry);
  const principal = decodePrincipal(capturedRequest);
  assert.equal(principal.kind, "service");
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.deepEqual(principal.scopes, ["compute:activation:evaluate"]);

  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.status_code, 200);
  assert.equal(result.body.decision.mode, 1);
  assert.equal(result.body.activation_state.version, 9);
});

test("policy evaluation fails closed when the trusted GROUP Service Binding is missing", async () => {
  const env = envFor(async () => { throw new Error("must not be called"); });
  delete env.GROUP;
  const payload = await (await callWithTestAccess(handleRequest, rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: telemetry
  }), env, identity)).json();
  assert.equal(payload.result.isError, true);
});

test("policy evaluation rejects incomplete telemetry before contacting GROUP", async () => {
  let called = false;
  const env = envFor(async () => { called = true; return Response.json({}); });
  const { quality_score, ...incomplete } = telemetry;
  const payload = await (await callWithTestAccess(handleRequest, rpc("tools/call", {
    name: "compute_activation_evaluate",
    arguments: incomplete
  }), env, identity)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /INVALID_SKILL_INPUT/);
});
