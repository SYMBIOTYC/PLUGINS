import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest, MAX_REQUEST_BYTES } from "../src/index.mjs";

const access = {
  access: {
    getIdentity: async () => ({ email: "owner@example.invalid", id: "access-subject-test" })
  }
};

function rpc(method, params = {}, id = 1) {
  return new Request("https://amphetamin.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
}

test("rejects requests without Cloudflare Access identity", async () => {
  const response = await handleRequest(rpc("tools/list"), {}, {});
  assert.equal(response.status, 401);
});

test("rejects Access context without a verified identity", async () => {
  const response = await handleRequest(rpc("tools/list"), {}, {
    access: { getIdentity: async () => null }
  });
  assert.equal(response.status, 401);
});

test("initializes a stateless MCP session", async () => {
  const response = await handleRequest(rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" }
  }), {}, access);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.result.protocolVersion, "2025-03-26");
  assert.equal(payload.result.serverInfo.name, "symbiotyc-amphetamin");
});

test("advertises the read-only GROUP health tool and bounded compute tools", async () => {
  const response = await handleRequest(rpc("tools/list"), {}, access);
  const payload = await response.json();
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["group.health", "compute_capabilities", "compute_submit_job", "compute_get_job", "compute_cancel_job"]);
  assert.equal(payload.result.tools[0].inputSchema.additionalProperties, false);
});

test("calls GROUP only through the private Service Binding", async () => {
  let called = false;
  const env = {
    GROUP: {
      fetch: async (request) => {
        called = true;
        assert.equal(new URL(request.url).pathname, "/health");
        return Response.json({
          status: "ok",
          service: "symbiotyc-group-control-plane",
          protocol: "symbiotyc.compute.v1",
          dispatch_enabled: false
        });
      }
    }
  };
  const response = await handleRequest(rpc("tools/call", {
    name: "group.health",
    arguments: {}
  }), env, access);
  const payload = await response.json();
  assert.equal(called, true);
  assert.equal(payload.result.isError, false);
  assert.match(payload.result.content[0].text, /dispatch_enabled/);
});

test("fails closed when the GROUP binding is absent", async () => {
  const response = await handleRequest(rpc("tools/call", {
    name: "group.health",
    arguments: {}
  }), {}, access);
  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /GROUP service binding is unavailable/);
});

test("does not execute unknown tools", async () => {
  const response = await handleRequest(rpc("tools/call", {
    name: "group.jobs.create",
    arguments: {}
  }), { GROUP: { fetch: async () => { throw new Error("must not be called"); } } }, access);
  const payload = await response.json();
  assert.equal(payload.error.code, -32602);
});

test("rejects oversized request bodies before parsing", async () => {
  const request = new Request("https://amphetamin.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(MAX_REQUEST_BYTES + 1) },
    body: "{}"
  });
  const response = await handleRequest(request, {}, access);
  assert.equal(response.status, 413);
});

test("acknowledges MCP notifications without a response body", async () => {
  const response = await handleRequest(rpc("notifications/initialized", {}, undefined), {}, access);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("exports a Cloudflare Worker fetch handler", async () => {
  assert.equal(typeof worker.fetch, "function");
});


const JOB_ID = "11111111-2222-4333-8444-555555555555";
const JOB_INTENT = {
  protocol: "symbiotyc.compute.v1",
  schema_version: "1.0",
  operation_id: "example.run",
  input: { operation: "calculate" },
  constraints: { cpu_millis: 1000, memory_mib: 512, timeout_seconds: 300 },
  output_policy: { format: "json", max_bytes: 4096 }
};

function decodePrincipal(request) {
  const encoded = request.headers.get("x-symbiotyc-principal");
  assert.ok(encoded);
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

const computeEnv = (fetch, overrides = {}) => ({
  COMPUTE_TENANT_ID: "symbiotyc",
  COMPUTE_PROJECT_ID: "compute",
  GROUP: { fetch },
  ...overrides
});

test("compute_capabilities uses Access identity-derived user principal over GROUP binding", async () => {
  let outbound;
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_capabilities",
    arguments: {}
  }), computeEnv(async (request) => {
    outbound = request;
    return Response.json({
      protocol: "symbiotyc.compute.v1",
      job_submission_enabled: false,
      enabled_operations: [],
      quota_configured: false,
      dispatch_enabled: false,
      components: { job_api: "ready", scheduler: "not_implemented" }
    });
  }), access);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.isError, false);
  assert.equal(outbound.method, "GET");
  assert.equal(new URL(outbound.url).pathname, "/v1/capabilities");
  assert.equal(outbound.headers.get("x-symbiotyc-caller"), "amphetamin");
  const principal = decodePrincipal(outbound);
  assert.equal(principal.kind, "user");
  assert.equal(principal.tenant_id, "symbiotyc");
  assert.equal(principal.project_id, "compute");
  assert.match(principal.actor_id, /^access:[a-f0-9]{64}$/);
  assert.notEqual(principal.actor_id, "owner@example.invalid");
  assert.deepEqual(principal.scopes, [
    "compute:jobs:read",
    "compute:jobs:write",
    "compute:jobs:cancel"
  ]);
  assert.equal("email" in principal, false);
});

test("compute_submit_job is blocked unless GROUP enables the operation and quota", async () => {
  const calls = [];
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_submit_job",
    arguments: { idempotency_key: "submit:denied-0001", job_intent: JOB_INTENT }
  }), computeEnv(async (request) => {
    calls.push(request.url);
    return Response.json({
      protocol: "symbiotyc.compute.v1",
      job_submission_enabled: false,
      enabled_operations: [],
      quota_configured: false,
      dispatch_enabled: false
    });
  }), access);

  const payload = await response.json();
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /JOB_SUBMISSION_DISABLED/);
  assert.deepEqual(calls, ["https://group.internal/v1/capabilities"]);
});

test("compute_submit_job forwards one idempotency key and reports QUEUED as acceptance only", async () => {
  const calls = [];
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_submit_job",
    arguments: { idempotency_key: "submit:stable-0001", job_intent: JOB_INTENT }
  }), computeEnv(async (request) => {
    calls.push(request);
    if (new URL(request.url).pathname === "/v1/capabilities") {
      return Response.json({
        protocol: "symbiotyc.compute.v1",
        job_submission_enabled: true,
        enabled_operations: ["example.run"],
        quota_configured: true,
        dispatch_enabled: false
      });
    }
    return Response.json({
      job_id: JOB_ID,
      operation_id: "example.run",
      state: "QUEUED",
      status_url: "/v1/jobs/" + JOB_ID,
      replayed: false
    }, { status: 202 });
  }), access);

  const payload = await response.json();
  const value = JSON.parse(payload.result.content[0].text);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "POST");
  assert.equal(new URL(calls[1].url).pathname, "/v1/jobs");
  assert.equal(calls[1].headers.get("idempotency-key"), "submit:stable-0001");
  assert.equal(value.state, "QUEUED");
  assert.equal(value.execution_started, false);
  assert.equal(value.dispatch_enabled, false);
  assert.equal(value.idempotency_key, "submit:stable-0001");
});

test("unknown Job acceptance outcome returns the same idempotency key without automatic retry", async () => {
  let calls = 0;
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_submit_job",
    arguments: { idempotency_key: "submit:unknown-0001", job_intent: JOB_INTENT }
  }), computeEnv(async (request) => {
    calls++;
    if (new URL(request.url).pathname === "/v1/capabilities") {
      return Response.json({
        protocol: "symbiotyc.compute.v1",
        job_submission_enabled: true,
        enabled_operations: ["example.run"],
        quota_configured: true,
        dispatch_enabled: false
      });
    }
    throw new Error("simulated service binding timeout");
  }), access);

  const payload = await response.json();
  assert.equal(calls, 2);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /JOB_ACCEPTANCE_UNKNOWN/);
  assert.match(payload.result.content[0].text, /submit:unknown-0001/);
});

test("compute_get_job and compute_cancel_job keep tenant and actor scope server-derived", async () => {
  const calls = [];
  const env = computeEnv(async (request) => {
    calls.push(request);
    if (new URL(request.url).pathname.endsWith("/cancel")) {
      return Response.json({ job_id: JOB_ID, state: "CANCELLED" });
    }
    return Response.json({ job_id: JOB_ID, operation_id: "example.run", state: "QUEUED" });
  });
  const read = await handleRequest(rpc("tools/call", {
    name: "compute_get_job",
    arguments: { job_id: JOB_ID }
  }), env, access);
  assert.equal(read.status, 200);
  const cancel = await handleRequest(rpc("tools/call", {
    name: "compute_cancel_job",
    arguments: { job_id: JOB_ID }
  }), env, access);
  assert.equal(cancel.status, 200);

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/v1/jobs/" + JOB_ID);
  assert.equal(new URL(calls[1].url).pathname, "/v1/jobs/" + JOB_ID + "/cancel");
  for (const request of calls) {
    const principal = decodePrincipal(request);
    assert.equal(principal.tenant_id, "symbiotyc");
    assert.equal(principal.project_id, "compute");
    assert.equal(principal.kind, "user");
    assert.match(principal.actor_id, /^access:[a-f0-9]{64}$/);
  }
});

test("tool arguments cannot override tenant, project, actor, or scopes", async () => {
  let called = false;
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_submit_job",
    arguments: {
      idempotency_key: "submit:spoof-0001",
      job_intent: JOB_INTENT,
      tenant_id: "other-tenant",
      project_id: "other-project",
      actor_id: "admin",
      scopes: ["compute:jobs:admin"]
    }
  }), computeEnv(async () => {
    called = true;
    throw new Error("GROUP must not be called for spoofed arguments");
  }), access);
  const payload = await response.json();
  assert.equal(called, false);
  assert.equal(payload.error, undefined);
  assert.equal(payload.result?.isError, true);
  assert.match(payload.result.content[0].text, /INVALID_ARGUMENTS/);
});


test("invalid Access identity email cannot produce a GROUP principal", async () => {
  let called = false;
  const ctx = { access: { getIdentity: async () => ({ email: "not-an-email" }) } };
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_capabilities",
    arguments: {}
  }), computeEnv(async () => {
    called = true;
    throw new Error("GROUP must not be called without a valid Access identity");
  }), ctx);
  const payload = await response.json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /TRUSTED_PRINCIPAL_UNAVAILABLE/);
});

test("missing tenant or project mapping fails closed before GROUP is called", async () => {
  let called = false;
  const response = await handleRequest(rpc("tools/call", {
    name: "compute_capabilities",
    arguments: {}
  }), computeEnv(async () => {
    called = true;
    throw new Error("GROUP must not be called without tenant/project mapping");
  }, { COMPUTE_PROJECT_ID: "" }), access);
  const payload = await response.json();
  assert.equal(called, false);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /TRUSTED_PRINCIPAL_UNAVAILABLE/);
});
