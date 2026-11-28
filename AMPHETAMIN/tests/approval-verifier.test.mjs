import test from "node:test";
import assert from "node:assert/strict";
import { createGroupApprovalVerifier } from "../src/approval-verifier.mjs";

const principal = {
  kind: "user",
  tenant_id: "symbiotyc",
  project_id: "compute",
  actor_id: "access:actor-hash",
  scopes: ["compute:read", "compute:jobs:read", "compute:jobs:write", "compute:approvals:consume"]
};
const claims = {
  request_id: "8c3f3e26-91a6-4e0e-a5f2-2b8e8a9f0b11",
  tool_id: "symbiotyc.group",
  invocation_id: "submit_job",
  operation_id: "image.render",
  side_effect: "write",
  request_hash: "a".repeat(64)
};
const approvalId = "7d1a7e10-4c33-4b6f-9e33-7a4d8b9d0e11";

function decodePrincipal(encoded) {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return JSON.parse(atob(padded));
}

test("fails closed until the GROUP approval routes are explicitly marked live", async () => {
  let called = false;
  const verify = createGroupApprovalVerifier({ GROUP: { fetch: async () => { called = true; } } }, principal);
  assert.equal(await verify(approvalId, claims), false);
  assert.equal(called, false);
});

test("consumes only a matching submit approval using a consume-only principal", async () => {
  let captured;
  const env = {
    GROUP_APPROVALS_LIVE: "true",
    GROUP: { fetch: async request => {
      captured = request;
      return Response.json({ approval_id: approvalId, status: "consumed" });
    } }
  };
  const verify = createGroupApprovalVerifier(env, principal);
  assert.equal(await verify(approvalId, claims), true);
  assert.equal(new URL(captured.url).pathname, `/v1/approvals/${approvalId}/consume`);
  assert.equal(captured.method, "POST");
  assert.deepEqual(decodePrincipal(captured.headers.get("x-symbiotyc-principal")).scopes, ["compute:approvals:consume"]);
  assert.deepEqual(await captured.json(), {
    action: "job.submit",
    operation_id: "image.render",
    request_hash: claims.request_hash
  });
});

test("rejects mismatched operation, invocation, side effect, malformed hash, and non-UUID approval", async () => {
  let called = false;
  const env = { GROUP_APPROVALS_LIVE: "true", GROUP: { fetch: async () => { called = true; return Response.json({}); } } };
  const verify = createGroupApprovalVerifier(env, principal);
  assert.equal(await verify(approvalId, { ...claims, operation_id: "not a valid operation" }), false);
  assert.equal(await verify(approvalId, { ...claims, invocation_id: "get_job" }), false);
  assert.equal(await verify(approvalId, { ...claims, side_effect: "read" }), false);
  assert.equal(await verify(approvalId, { ...claims, request_hash: "not-a-hash" }), false);
  assert.equal(await verify("not-a-uuid", claims), false);
  assert.equal(called, false);
});

test("rejects a successful HTTP response that does not confirm this approval was consumed", async () => {
  const env = {
    GROUP_APPROVALS_LIVE: "true",
    GROUP: { fetch: async () => Response.json({ approval_id: "00000000-0000-4000-8000-000000000000", status: "consumed" }) }
  };
  assert.equal(await createGroupApprovalVerifier(env, principal)(approvalId, claims), false);
});

test("propagates GROUP failures so Tool Runtime can fail closed", async () => {
  const env = { GROUP_APPROVALS_LIVE: "true", GROUP: { fetch: async () => { throw new Error("unavailable"); } } };
  await assert.rejects(createGroupApprovalVerifier(env, principal)(approvalId, claims), /unavailable/);
});

test("consumes a cancel approval only for the fixed job.cancel operation", async () => {
  let captured;
  const env = {
    GROUP_APPROVALS_LIVE: "true",
    GROUP: { fetch: async request => {
      captured = request;
      return Response.json({ approval_id: approvalId, status: "consumed" });
    } }
  };
  const cancelClaims = { ...claims, invocation_id: "cancel_job", operation_id: "job.cancel" };
  assert.equal(await createGroupApprovalVerifier(env, principal)(approvalId, cancelClaims), true);
  assert.deepEqual(await captured.json(), {
    action: "job.cancel",
    operation_id: "job.cancel",
    request_hash: claims.request_hash
  });
});
