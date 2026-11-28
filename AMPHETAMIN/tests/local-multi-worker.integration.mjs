import assert from "node:assert/strict";

const baseUrl = process.env.AMPHETAMIN_LOCAL_URL || "http://127.0.0.1:8787";
const workerDeadline = Date.now() + 30_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForWorker() {
  let lastError;
  while (Date.now() < workerDeadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error("local AMPHETAMIN Worker did not become ready", { cause: lastError });
}

async function callTool(name, args, id) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  assert.equal(response.status, 200, `MCP edge should return HTTP success for ${name}`);
  const rpc = await response.json();
  assert.equal(rpc.jsonrpc, "2.0");
  assert.equal(rpc.id, id);
  return rpc.result;
}

// AMPHETAMIN /health is a local process check only; it does not touch the
// GROUP Service Binding. Warm the binding with the read-only group.health tool
// before issuing the evaluation request. Retry only OUTCOME_UNKNOWN on this
// read-only probe; never retry the evaluation call.
async function waitForGroupBinding() {
  let lastOutcome = "no health attempt";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await callTool("group.health", {}, `local-group-health-${attempt}`);
    if (result?.isError === false) {
      const health = JSON.parse(result.content[0].text);
      assert.equal(health.status_code, 200, JSON.stringify(health));
      return;
    }

    const failure = JSON.parse(result?.content?.[0]?.text || "{}");
    lastOutcome = failure.error || "unexpected GROUP health failure";
    if (lastOutcome !== "OUTCOME_UNKNOWN") {
      assert.fail(`GROUP health warm-up failed: ${JSON.stringify(result)}`);
    }
    await sleep(250);
  }
  throw new Error(`GROUP Service Binding did not become ready: ${lastOutcome}`);
}

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

await waitForWorker();
await waitForGroupBinding();

const result = await callTool("compute_activation_evaluate", telemetry, "local-wasm-e2e");
assert.equal(result?.isError, false, JSON.stringify(result));

const evaluation = JSON.parse(result.content[0].text);
assert.equal(evaluation.status_code, 200, JSON.stringify(evaluation));
assert.ok(evaluation.body?.decision && typeof evaluation.body.decision === "object",
  "GROUP must return a decision from its compiled WASM evaluator");
assert.ok(evaluation.body?.activation_state && typeof evaluation.body.activation_state === "object",
  "GROUP must hydrate the durable activation state from local D1");
for (const key of [
  "mode",
  "worker_count",
  "request_refill",
  "request_capacity",
  "reason_code",
  "activation_remaining_minutes",
  "drive_multiplier_percent",
  "projected_burnout_score"
]) {
  assert.ok(Number.isInteger(evaluation.body.decision[key]),
    `WASM decision must include integer ${key}`);
}
assert.equal(evaluation.body.activation_state.deployment_streak, 0,
  "fresh local D1 state must start with no deployment streak");

console.log("PASS: AMPHETAMIN MCP → local GROUP Service Binding → GROUP WASM evaluator → local D1");
