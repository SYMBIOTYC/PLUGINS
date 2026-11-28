import test from "node:test";
import assert from "node:assert/strict";
import { ToolRuntime } from "../runtime/tool-runtime.mjs";

const request = (overrides = {}) => ({
  schema_version: "1.0",
  request_id: "8c3f3e26-91a6-4e0e-a5f2-2b8e8a9f0b11",
  tool_id: "symbiotyc.group",
  invocation_id: "submit_job",
  idempotency_key: "test-submit-idempotency-01",
  input: { job_intent: { operation_id: "image.render", payload: { prompt: "test" } } },
  ...overrides
});

const registry = {
  tools: {
    "symbiotyc.group": {
      status: "verified",
      invocations: {
        submit_job: {
          status: "verified",
          side_effect: "write",
          operation_id_from_input: "job_intent.operation_id",
          required_scopes: ["compute:jobs:write"],
          input_schema: {
            type: "object",
            required: ["job_intent"],
            properties: {
              job_intent: {
                type: "object",
                required: ["operation_id", "payload"],
                properties: {
                  operation_id: { type: "string" },
                  payload: { type: "object" }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        }
      }
    }
  }
};

function makeStore() {
  let state = null;
  let savedResult = null;
  return {
    get state() { return state; },
    async claim(_key, hash) {
      if (state === "succeeded") return { state: "replay", result: savedResult };
      if (state) {
        const error = new Error("already claimed");
        error.code = "INVOCATION_IN_PROGRESS";
        error.statusCode = 409;
        throw error;
      }
      state = "in_progress";
      this.hash = hash;
      return { state: "claimed", result: null };
    },
    async finish(_key, nextState, result = null) {
      state = nextState;
      savedResult = result;
      return true;
    }
  };
}

const principal = { tenant_id: "symbiotyc", actor_id: "access:test", scopes: ["compute:jobs:write"] };

test("marks a newly claimed invocation failed when its approval is missing", async () => {
  const store = makeStore();
  let handlerCalled = false;
  const runtime = new ToolRuntime(registry, {
    "symbiotyc.group:submit_job": async () => { handlerCalled = true; return { accepted: true }; }
  }, {
    idempotencyStore: store,
    auditSink: async () => {},
    approvalVerifier: async () => true
  });

  await assert.rejects(runtime.invoke(request(), principal), error => error.code === "APPROVAL_REQUIRED");
  assert.equal(store.state, "failed");
  assert.equal(handlerCalled, false);
});

test("resolves idempotency replay before consuming a one-time approval", async () => {
  const store = makeStore();
  let verifierCalls = 0;
  let handlerCalls = 0;
  let observedClaims;
  const runtime = new ToolRuntime(registry, {
    "symbiotyc.group:submit_job": async () => { handlerCalls += 1; return { accepted: true }; }
  }, {
    idempotencyStore: store,
    auditSink: async () => {},
    approvalVerifier: async (_approvalId, claims) => {
      verifierCalls += 1;
      observedClaims = claims;
      return true;
    }
  });
  const approvedRequest = request({ approval_id: "7d1a7e10-4c33-4b6f-9e33-7a4d8b9d0e11" });

  const first = await runtime.invoke(approvedRequest, principal);
  const replay = await runtime.invoke(approvedRequest, principal);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(verifierCalls, 1);
  assert.equal(handlerCalls, 1);
  assert.equal(observedClaims.operation_id, "image.render");
  assert.equal(observedClaims.request_id, approvedRequest.request_id);
});
