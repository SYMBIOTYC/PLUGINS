import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.mjs";

const PROTOCOL = "2026-07-28";
const UUID = "11111111-2222-4333-8444-555555555555";
const INTENT = {
  protocol: "symbiotyc.compute.v1",
  schema_version: "1.0",
  operation_id: "example.run",
  input: { command: "calculate" },
  constraints: { cpu_millis: 1000, memory_mib: 512, timeout_seconds: 300 },
  output_policy: { format: "json", max_bytes: 4096 }
};

function mcpRequest(method, params = {}, options = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
    "Mcp-Method": method,
    ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
    ...(options.headers || {})
  });
  const meta = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": { name: "amphetamin-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const message = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } };
  return new Request("https://amphetamin.internal/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function decodePrincipal(encoded) {
  const base = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base + "=".repeat((4 - base.length % 4) % 4)));
}

function makeEnv(groupFetch, overrides = {}) {
  return {
    TENANT_ID: "symbiotyc",
    PROJECT_ID: "compute",
    ACTOR_ID: "symbiotyc-cloud-assistant",
    GROUP: { fetch: groupFetch },
    ...overrides
  };
}

function textResult(payload) {
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.id, 1);
  assert.ok(Array.isArray(payload.result?.content));
  return JSON.parse(payload.result.content[0].text);
}

test("GET health is internal diagnostic and declares dispatch disabled", async () => {
  const res = await worker.fetch(new Request("https://amphetamin.internal/health"), makeEnv(async () => {
    throw new Error("health must not call GROUP");
  }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, "amphetamin-mcp");
  assert.equal(body.dispatch_enabled, false);
});

test("MCP endpoint rejects public Origin values", async () => {
  const res = await worker.fetch(
    mcpRequest("tools/list", {}, { headers: { origin: "https://evil.example" } }),
    makeEnv(async () => { throw new Error("must not call GROUP"); })
  );
  assert.equal(res.status, 403);
});

test("MCP endpoint requires the current protocol metadata header", async () => {
  const req = mcpRequest("tools/list");
  req.headers.delete("MCP-Protocol-Version");
  const res = await worker.fetch(req, makeEnv(async () => { throw new Error("must not call GROUP"); }));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, -32020);
});

test("MCP endpoint checks standard headers against the JSON-RPC body", async () => {
  const req = mcpRequest("tools/call", { name: "compute_capabilities", arguments: {} });
  req.headers.set("Mcp-Name", "another_tool");
  const res = await worker.fetch(req, makeEnv(async () => { throw new Error("must not call GROUP"); }));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, -32020);
});

test("tools/list advertises only bounded compute operations", async () => {
  const res = await worker.fetch(
    mcpRequest("tools/list"),
    makeEnv(async () => { throw new Error("listing tools must not call GROUP"); })
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  const names = body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "compute_capabilities",
    "compute_submit_job",
    "compute_get_job",
    "compute_cancel_job"
  ]);
  const submit = body.result.tools.find((tool) => tool.name === "compute_submit_job");
  assert.equal(submit.inputSchema.additionalProperties, false);
  assert.deepEqual(submit.inputSchema.required, ["idempotency_key", "job_intent"]);
});

test("capabilities calls GROUP with a server-derived service principal", async () => {
  let observed;
  const res = await worker.fetch(
    mcpRequest("tools/call", { name: "compute_capabilities", arguments: {} }),
    makeEnv(async (request) => {
      observed = request;
      return response({
        protocol: "symbiotyc.compute.v1",
        job_submission_enabled: false,
        enabled_operations: [],
        quota_configured: false,
        dispatch_enabled: false,
        components: { scheduler: "not_implemented", dispatcher: "not_implemented" }
      });
    })
  );
  const result = textResult(await res.json());
  assert.equal(res.status, 200);
  assert.equal(observed.url, "https://group/v1/capabilities");
  assert.equal(observed.headers.get("x-symbiotyc-caller"), "amphetamin");
  assert.deepEqual(decodePrincipal(observed.headers.get("x-symbiotyc-principal")), {
    kind: "service",
    tenant_id: "symbiotyc",
    project_id: "compute",
    actor_id: "symbiotyc-cloud-assistant",
    scopes: ["compute:jobs:read", "compute:jobs:write", "compute:jobs:cancel"]
  });
  assert.equal(result.dispatch_enabled, false);
});

test("compute_submit_job is blocked when GROUP capabilities do not enable submission", async () => {
  const calls = [];
  const res = await worker.fetch(
    mcpRequest("tools/call", {
      name: "compute_submit_job",
      arguments: { idempotency_key: "submit:request-000001", job_intent: INTENT }
    }),
    makeEnv(async (request) => {
      calls.push(request.url);
      return response({
        protocol: "symbiotyc.compute.v1",
        job_submission_enabled: false,
        enabled_operations: [],
        quota_configured: false,
        dispatch_enabled: false
      });
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /submission is disabled/i);
  assert.deepEqual(calls, ["https://group/v1/capabilities"]);
});

test("job submission reuses the caller's idempotency key and does not invent execution success", async () => {
  const calls = [];
  const res = await worker.fetch(
    mcpRequest("tools/call", {
      name: "compute_submit_job",
      arguments: { idempotency_key: "submit:stable-intent-0001", job_intent: INTENT }
    }),
    makeEnv(async (request) => {
      calls.push(request);
      if (request.url.endsWith("/v1/capabilities")) {
        return response({
          protocol: "symbiotyc.compute.v1",
          job_submission_enabled: true,
          enabled_operations: ["example.run"],
          quota_configured: true,
          dispatch_enabled: false
        });
      }
      return response({
        job_id: UUID,
        operation_id: "example.run",
        state: "QUEUED",
        status_url: "/v1/jobs/" + UUID,
        replayed: false
      }, 202);
    })
  );
  const result = textResult(await res.json());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "https://group/v1/jobs");
  assert.equal(calls[1].headers.get("idempotency-key"), "submit:stable-intent-0001");
  assert.equal(result.state, "QUEUED");
  assert.equal(result.execution_started, false);
  assert.equal(result.dispatch_enabled, false);
});

test("unknown outcome returns the original idempotency key and never retries automatically", async () => {
  let calls = 0;
  const res = await worker.fetch(
    mcpRequest("tools/call", {
      name: "compute_submit_job",
      arguments: { idempotency_key: "submit:stable-timeout-0001", job_intent: INTENT }
    }),
    makeEnv(async (request) => {
      calls++;
      if (request.url.endsWith("/v1/capabilities")) {
        return response({
          protocol: "symbiotyc.compute.v1",
          job_submission_enabled: true,
          enabled_operations: ["example.run"],
          quota_configured: true,
          dispatch_enabled: false
        });
      }
      throw new Error("service binding timeout");
    })
  );
  const body = await res.json();
  assert.equal(calls, 2);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /submit:stable-timeout-0001/);
  assert.match(body.result.content[0].text, /unknown/i);
});

test("job read uses server-derived tenant scope", async () => {
  const paths = [];
  const res = await worker.fetch(
    mcpRequest("tools/call", { name: "compute_get_job", arguments: { job_id: UUID } }),
    makeEnv(async (request) => {
      paths.push(request.url);
      assert.equal(decodePrincipal(request.headers.get("x-symbiotyc-principal")).tenant_id, "symbiotyc");
      return response({ job_id: UUID, operation_id: "example.run", state: "QUEUED" });
    })
  );
  const value = textResult(await res.json());
  assert.equal(value.job_id, UUID);
  assert.deepEqual(paths, ["https://group/v1/jobs/" + UUID]);
});

test("missing server principal configuration fails closed", async () => {
  let called = false;
  const res = await worker.fetch(
    mcpRequest("tools/call", { name: "compute_capabilities", arguments: {} }),
    makeEnv(async () => { called = true; return response({}); }, { TENANT_ID: "" })
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.result.isError, true);
  assert.equal(called, false);
});
