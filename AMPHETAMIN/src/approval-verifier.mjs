const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const OPERATION_ACTIONS = Object.freeze({
  "job.submit": { action: "job.submit", invocation_id: "submit_job" },
  "job.cancel": { action: "job.cancel", invocation_id: "cancel_job" }
});
const MAX_RESPONSE_BYTES = 8 * 1024;

function encodePrincipal(principal) {
  const assertion = {
    kind: "user",
    tenant_id: principal.tenant_id,
    project_id: principal.project_id,
    actor_id: principal.actor_id,
    scopes: ["compute:approvals:consume"]
  };
  const bytes = new TextEncoder().encode(JSON.stringify(assertion));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

async function readJsonLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GROUP approval response exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Build a fail-closed, one-time GROUP approval consumer.
 * The caller supplies only the trusted Access-derived identity; this adapter
 * narrows its Service Binding principal to the single consume scope.
 */
export function createGroupApprovalVerifier(env, principal) {
  return async (approvalId, claims) => {
    if (env?.GROUP_APPROVALS_LIVE !== "true") return false;
    if (!env?.GROUP || typeof env.GROUP.fetch !== "function") {
      throw new Error("GROUP approval service binding is unavailable");
    }
    if (
      typeof principal?.tenant_id !== "string" || !principal.tenant_id ||
      typeof principal?.project_id !== "string" || !principal.project_id ||
      typeof principal?.actor_id !== "string" || !principal.actor_id
    ) return false;
    if (typeof approvalId !== "string" || !UUID_RE.test(approvalId)) return false;

    const operation = OPERATION_ACTIONS[claims?.operation_id];
    if (
      !operation ||
      claims?.tool_id !== "symbiotyc.group" ||
      claims?.invocation_id !== operation.invocation_id ||
      claims?.side_effect !== "write" ||
      typeof claims?.request_hash !== "string" || !HASH_RE.test(claims.request_hash) ||
      typeof claims?.request_id !== "string" || !UUID_RE.test(claims.request_id)
    ) return false;

    const response = await env.GROUP.fetch(new Request(
      `https://group.internal/v1/approvals/${approvalId}/consume`,
      {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "x-symbiotyc-caller": "amphetamin",
          "x-symbiotyc-principal": encodePrincipal(principal),
          "x-correlation-id": claims.request_id
        },
        body: JSON.stringify({
          action: operation.action,
          operation_id: claims.operation_id,
          request_hash: claims.request_hash
        })
      }
    ));
    const body = await readJsonLimited(response);
    return response.status === 200 &&
      body?.approval_id === approvalId &&
      body?.status === "consumed";
  };
}
