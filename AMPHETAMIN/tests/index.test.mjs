import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest, MAX_REQUEST_BYTES } from "../src/index.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const access = { access: { getIdentity: async () => ({ email: "owner@example.invalid", id: "access-subject-test" }) } };
const baseEnv = (overrides = {}) => ({ COMPUTE_TENANT_ID: "symbiotyc", RUNTIME_DB: new FakeD1(), ...overrides });
function rpc(method, params = {}, id = 1) {
  return new Request("https://amphetamin.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

test("rejects requests without Cloudflare Access identity", async () => {
  assert.equal((await handleRequest(rpc("tools/list"), baseEnv(), {})).status, 401);
});
test("rejects Access context without a verified identity", async () => {
  assert.equal((await handleRequest(rpc("tools/list"), baseEnv(), { access: { getIdentity: async () => null } })).status, 401);
});
test("initializes a stateless MCP session", async () => {
  const response = await handleRequest(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } }), baseEnv(), access);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.result.protocolVersion, "2025-03-26");
  assert.equal(payload.result.serverInfo.name, "symbiotyc-amphetamin");
});
test("advertises only the read-only GROUP health tool", async () => {
  const payload = await (await handleRequest(rpc("tools/list"), baseEnv(), access)).json();
  assert.deepEqual(payload.result.tools.map(tool => tool.name), ["group.health"]);
  assert.equal(payload.result.tools[0].inputSchema.additionalProperties, false);
});
test("executes group.health through Skill Runtime, Tool Runtime, and private GROUP binding", async () => {
  const db = new FakeD1();
  let called = false;
  const env = { COMPUTE_TENANT_ID: "symbiotyc", RUNTIME_DB: db, GROUP: { fetch: async request => {
    called = true;
    assert.equal(new URL(request.url).pathname, "/health");
    return Response.json({ status: "ok", service: "symbiotyc-group-control-plane", protocol: "symbiotyc.compute.v1", dispatch_enabled: false });
  }}};
  const payload = await (await handleRequest(rpc("tools/call", { name: "group.health", arguments: {} }), env, access)).json();
  assert.equal(called, true);
  assert.equal(payload.result.isError, false);
  assert.match(payload.result.content[0].text, /dispatch_enabled/);
  assert.equal(db.auditEvents.length, 6);
  assert.equal(db.idempotency.size, 2);
  assert.ok(db.auditEvents.every(event => event.tenant_id === "symbiotyc"));
  assert.ok(db.auditEvents.every(event => !event.metadata_json.includes("owner@example.invalid")));
});
test("fails closed when durable runtime database binding is absent", async () => {
  let called = false;
  const payload = await (await handleRequest(rpc("tools/call", { name: "group.health", arguments: {} }), { COMPUTE_TENANT_ID: "symbiotyc", GROUP: { fetch: async () => { called = true; throw new Error("must not run"); } } }, access)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /RUNTIME_EXECUTION_FAILED/);
});
test("fails closed when the tenant mapping is missing", async () => {
  const payload = await (await handleRequest(rpc("tools/call", { name: "group.health", arguments: {} }), { RUNTIME_DB: new FakeD1(), GROUP: { fetch: async () => { throw new Error("must not run"); } } }, access)).json();
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /TENANT_MAPPING_UNAVAILABLE/);
});
test("fails closed when the GROUP binding is absent", async () => {
  const payload = await (await handleRequest(rpc("tools/call", { name: "group.health", arguments: {} }), baseEnv(), access)).json();
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /SKILL_OUTCOME_UNKNOWN/);
});
test("does not execute unknown tools", async () => {
  const payload = await (await handleRequest(rpc("tools/call", { name: "group.jobs.create", arguments: {} }), baseEnv(), access)).json();
  assert.equal(payload.error.code, -32602);
});
test("rejects oversized request bodies before parsing", async () => {
  const request = new Request("https://amphetamin.example/mcp", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_REQUEST_BYTES + 1) }, body: "{}" });
  assert.equal((await handleRequest(request, baseEnv(), access)).status, 413);
});
test("acknowledges MCP notifications without a response body", async () => {
  const request = new Request("https://amphetamin.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const response = await handleRequest(request, baseEnv(), access);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});
test("exports a Cloudflare Worker fetch handler", () => assert.equal(typeof worker.fetch, "function"));
