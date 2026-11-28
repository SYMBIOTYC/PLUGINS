import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest } from "../src/index.mjs";

const access = (email = "operator@example.com") => ({
  access: { getIdentity: async () => ({ email }) }
});
const json = async response => ({ status: response.status, body: await response.json() });
const rpc = (method, params = {}, id = 1) => new Request("https://amphetamin.test/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
});

test("unauthenticated MCP requests fail closed before protocol handling", async () => {
  const response = await worker.fetch(rpc("tools/list"), {}, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.equal((await response.json()).error, "access_authentication_required");
});

test("Access-authenticated initialize returns the declared MCP protocol and server identity", async () => {
  const response = await worker.fetch(rpc("initialize"), {}, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.protocolVersion, "2025-03-26");
  assert.equal(result.body.result.serverInfo.name, "symbiotyc-amphetamin");
});

test("tools/list exposes only the five registered AMPHETAMIN tools", async () => {
  const response = await worker.fetch(rpc("tools/list"), {}, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result.tools.map(tool => tool.name), [
    "group.health",
    "compute_capabilities",
    "compute_submit_job",
    "compute_get_job",
    "compute_cancel_job"
  ]);
});

test("Access identity is mapped server-side and GROUP is reached only through its Service Binding", async () => {
  let captured;
  const env = {
    COMPUTE_TENANT_ID: "symbiotyc",
    COMPUTE_PROJECT_ID: "compute",
    GROUP: {
      fetch: async request => {
        captured = request;
        return Response.json({
          protocol: "symbiotyc.compute.v1",
          job_submission_enabled: false,
          enabled_operations: [],
          quota_configured: false,
          dispatch_enabled: false
        });
      }
    }
  };
  const response = await worker.fetch(rpc("tools/call", {
    name: "compute_capabilities",
    arguments: {}
  }), env, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(captured.url, "https://group.internal/v1/capabilities");
  assert.equal(captured.headers.get("x-symbiotyc-caller"), "amphetamin");
  const principal = JSON.parse(Buffer.from(captured.headers.get("x-symbiotyc-principal"), "base64url").toString("utf8"));
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.match(principal.actor_id, /^access:[a-f0-9]{64}$/);
  assert.deepEqual(principal.scopes, [
    "compute:jobs:read",
    "compute:jobs:write",
    "compute:jobs:cancel"
  ]);
});

test("Job submission remains disabled when GROUP capabilities do not explicitly enable it", async () => {
  let writes = 0;
  const env = {
    COMPUTE_TENANT_ID: "symbiotyc",
    COMPUTE_PROJECT_ID: "compute",
    GROUP: {
      fetch: async request => {
        if (new URL(request.url).pathname === "/v1/jobs") writes += 1;
        return Response.json({
          job_submission_enabled: false,
          enabled_operations: [],
          dispatch_enabled: false
        });
      }
    }
  };
  const response = await worker.fetch(rpc("tools/call", {
    name: "compute_submit_job",
    arguments: {
      idempotency_key: "test-key-123456",
      job_intent: {
        protocol: "symbiotyc.compute.v1",
        schema_version: "1.0",
        operation_id: "image.thumbnail",
        input: {},
        constraints: { cpu_millis: 1000, memory_mib: 512, timeout_seconds: 300 },
        output_policy: { format: "json", max_bytes: 1024 }
      }
    }
  }), env, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.isError, true);
  assert.match(result.body.result.content[0].text, /JOB_SUBMISSION_DISABLED/);
  assert.equal(writes, 0);
});

test("tool arguments cannot override the server-derived tenant or project", async () => {
  const response = await worker.fetch(rpc("tools/call", {
    name: "compute_capabilities",
    arguments: { tenant_id: "attacker-tenant", project_id: "attacker-project" }
  }), {}, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.result.isError, true);
  assert.match(result.body.result.content[0].text, /unsupported property/);
});

test("malformed JSON-RPC input returns a parse error without invoking GROUP", async () => {
  const response = await worker.fetch(new Request("https://amphetamin.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{"
  }), {}, access());
  const result = await json(response);
  assert.equal(result.status, 200);
  assert.equal(result.body.error.code, -32700);
});
