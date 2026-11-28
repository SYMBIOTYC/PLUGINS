import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.mjs";
import { callWithTestAccess } from "./access-fixture.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const identity = { access: { aud: "test-access-audience", getIdentity: async () => ({ email: "owner@example.invalid", id: "access-owner-1" }) } };
const envFor = (fetch) => ({
  COMPUTE_TENANT_ID: "symbiotyc",
  COMPUTE_PROJECT_ID: "compute",
  RUNTIME_DB: new FakeD1(),
  GROUP: { fetch }
});
const rpc = (method, params = {}, id = 41) => new Request("https://amphetamin.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
});
const decodePrincipal = request => JSON.parse(
  Buffer.from(request.headers.get("x-symbiotyc-principal"), "base64url").toString("utf8")
);

test("MCP exposes activation state as read-only and uses a scoped service principal", async () => {
  const listed = await (await callWithTestAccess(handleRequest, rpc("tools/list"), envFor(async () => Response.json({})), identity)).json();
  assert.ok(listed.result.tools.some(tool => tool.name === "compute_activation_state"));

  let captured;
  const env = envFor(async request => {
    captured = request;
    assert.equal(new URL(request.url).pathname, "/v1/activation/state");
    return Response.json({
      activation_remaining_minutes: 245,
      deployment_streak: 3,
      drive_multiplier_percent: 130,
      burnout_score: 45,
      recovery_remainder_minutes: 20,
      updated_at: "2026-11-28T10:00:00.000Z",
      version: 9
    });
  });
  const payload = await (await callWithTestAccess(handleRequest, rpc("tools/call", {
    name: "compute_activation_state", arguments: {}
  }), env, identity)).json();
  const principal = decodePrincipal(captured);
  assert.equal(payload.result.isError, false);
  assert.equal(principal.kind, "service");
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.deepEqual(principal.scopes, ["compute:activation:read"]);
  assert.equal(JSON.parse(payload.result.content[0].text).status_code, 200);
});

test("activation state tool fails closed when the trusted GROUP binding is missing", async () => {
  const env = envFor(async () => { throw new Error("must not be called"); });
  delete env.GROUP;
  const payload = await (await callWithTestAccess(handleRequest, rpc("tools/call", {
    name: "compute_activation_state", arguments: {}
  }), env, identity)).json();
  assert.equal(payload.result.isError, true);
  assert.equal(payload.result.isError, true);
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(typeof result.error, "string");
});
