import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const identity = { access: { getIdentity: async () => ({ email: "owner@example.invalid", id: "access-owner-1" }) } };
const JOB_ID = "2b8c2d6f-2f1d-4e8c-9d1c-9a8f3e5b7c10";
const envFor = (fetch) => ({
  COMPUTE_TENANT_ID: "symbiotyc",
  COMPUTE_PROJECT_ID: "compute",
  RUNTIME_DB: new FakeD1(),
  GROUP: { fetch }
});
const rpc = (method, params = {}, id = 31) => new Request("https://amphetamin.example/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
});
const decodePrincipal = request => {
  const value = request.headers.get("x-symbiotyc-principal");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
};

test("MCP lists only health and the two read-only compute tools", async () => {
  const response = await handleRequest(rpc("tools/list"), envFor(async () => Response.json({})), identity);
  const payload = await response.json();
  assert.deepEqual(payload.result.tools.map(tool => tool.name), [
    "group.health",
    "compute_capabilities",
    "compute_get_job",
    "compute_activation_state"
  ]);
  const getJob = payload.result.tools.find(tool => tool.name === "compute_get_job");
  assert.deepEqual(getJob.inputSchema.required, ["job_id"]);
  assert.equal(getJob.inputSchema.additionalProperties, false);
});

test("compute_capabilities uses server-derived owner/project identity over the private binding", async () => {
  const db = new FakeD1();
  let captured;
  const env = envFor(async request => {
    captured = request;
    assert.equal(new URL(request.url).pathname, "/v1/capabilities");
    return Response.json({
      protocol: "symbiotyc.compute.v1",
      job_submission_enabled: false,
      enabled_operations: [],
      quota_configured: false,
      dispatch_enabled: false,
      components: { job_api: "ready", scheduler: "not_implemented" }
    });
  });
  env.RUNTIME_DB = db;
  const response = await handleRequest(rpc("tools/call", { name: "compute_capabilities", arguments: {} }), env, identity);
  const payload = await response.json();
  const principal = decodePrincipal(captured);
  assert.equal(payload.result.isError, false);
  assert.equal(captured.headers.get("x-symbiotyc-caller"), "amphetamin");
  assert.equal(principal.kind, "user");
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.deepEqual(principal.scopes, ["compute:read", "compute:jobs:read"]);
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.status_code, 200);
  assert.equal(result.body.job_submission_enabled, false);
  assert.equal(result.body.dispatch_enabled, false);
  assert.equal(db.idempotency.size, 2);
  assert.equal(db.auditEvents.length, 6);
});

test("compute_get_job reads only the caller's server-derived tenant/project", async () => {
  let captured;
  const env = envFor(async request => {
    captured = request;
    assert.equal(new URL(request.url).pathname, `/v1/jobs/${JOB_ID}`);
    return Response.json({
      job_id: JOB_ID,
      operation_id: "image.thumbnail",
      state: "QUEUED",
      record_version: 1,
      created_at: "2026-11-28T01:00:00.000Z",
      updated_at: "2026-11-28T01:00:00.000Z",
      deadline_at: null,
      correlation_id: "corr-123"
    });
  });
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_get_job", arguments: { job_id: JOB_ID }
  }), env, identity)).json();
  const principal = decodePrincipal(captured);
  assert.equal(payload.result.isError, false);
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.ok(principal.scopes.includes("compute:jobs:read"));
  assert.equal(principal.scopes.includes("compute:jobs:write"), false);
  assert.equal(principal.scopes.includes("compute:jobs:cancel"), false);
});

test("compute_get_job reports a tenant-scoped 404 as a normal tool error without quarantining the read", async () => {
  const db = new FakeD1();
  const env = envFor(async () => Response.json({ error: { code: "JOB_NOT_FOUND", message: "The requested Job was not found." } }, { status: 404 }));
  env.RUNTIME_DB = db;
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_get_job", arguments: { job_id: JOB_ID }
  }), env, identity)).json();
  assert.equal(payload.result.isError, true);
  const result = JSON.parse(payload.result.content[0].text);
  assert.equal(result.status_code, 404);
  assert.equal(result.body.error.code, "JOB_NOT_FOUND");
  assert.ok([...db.idempotency.values()].every(row => row.status === "succeeded"));
});

test("compute_get_job rejects malformed identifiers before calling GROUP", async () => {
  let called = false;
  const env = envFor(async () => { called = true; return Response.json({}); });
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_get_job", arguments: { job_id: "not-a-uuid" }
  }), env, identity)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /INVALID_SKILL_INPUT/);
});

test("compute tool arguments cannot override tenant or project", async () => {
  let called = false;
  const env = envFor(async () => { called = true; return Response.json({}); });
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_get_job", arguments: { job_id: JOB_ID, tenant_id: "other", project_id: "other" }
  }), env, identity)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /INVALID_SKILL_INPUT/);
});

test("compute reads fail closed when the trusted project mapping is missing", async () => {
  let called = false;
  const env = envFor(async () => { called = true; return Response.json({}); });
  delete env.COMPUTE_PROJECT_ID;
  const payload = await (await handleRequest(rpc("tools/call", {
    name: "compute_capabilities", arguments: {}
  }), env, identity)).json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /PROJECT_MAPPING_UNAVAILABLE/);
});

test("state-changing compute tools remain unadvertised until approval verification exists", async () => {
  const response = await handleRequest(rpc("tools/list"), envFor(async () => Response.json({})), identity);
  const payload = await response.json();
  const names = payload.result.tools.map(tool => tool.name);
  assert.equal(names.includes("compute_submit_job"), false);
  assert.equal(names.includes("compute_cancel_job"), false);
});
