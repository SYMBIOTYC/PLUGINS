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

test("advertises only the read-only GROUP health tool", async () => {
  const response = await handleRequest(rpc("tools/list"), {}, access);
  const payload = await response.json();
  assert.deepEqual(payload.result.tools.map((tool) => tool.name), ["group.health"]);
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
