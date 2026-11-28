export const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_GROUP_RESPONSE_BYTES = 32 * 1024;
const SERVER_INFO = Object.freeze({
  name: "symbiotyc-amphetamin",
  version: "0.2.0"
});
const PROTOCOL_VERSION = "2025-03-26";
const GROUP_SCOPES = Object.freeze([
  "compute:jobs:read",
  "compute:jobs:write",
  "compute:jobs:cancel"
]);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const JOB_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "schema_version", "operation_id", "input", "constraints", "output_policy"],
  properties: {
    protocol: { const: "symbiotyc.compute.v1" },
    schema_version: { type: "string", pattern: "^1\\.[0-9]+$" },
    operation_id: { type: "string", minLength: 2, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]+$" },
    input: { type: "object", maxProperties: 128 },
    constraints: {
      type: "object",
      additionalProperties: false,
      required: ["cpu_millis", "memory_mib", "timeout_seconds"],
      properties: {
        worker_pool: { enum: ["CLOUD-COMPUTE", "CLOUD-CPU", "CLOUD-VPS"] },
        required_capabilities: {
          type: "array", maxItems: 32, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 64 }
        },
        cpu_millis: { type: "integer", minimum: 1, maximum: 65536 },
        memory_mib: { type: "integer", minimum: 16, maximum: 1048576 },
        ephemeral_disk_mib: { type: "integer", minimum: 16, maximum: 1048576 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
        max_attempts: { type: "integer", minimum: 1, maximum: 10 }
      }
    },
    output_policy: {
      type: "object",
      additionalProperties: false,
      required: ["format", "max_bytes"],
      properties: {
        format: { enum: ["json", "text", "binary"] },
        max_bytes: { type: "integer", minimum: 1, maximum: 1073741824 },
        media_types: {
          type: "array", maxItems: 32, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 }
        }
      }
    },
    deadline_at: { type: "string", format: "date-time" },
    client_reference: { type: "string", maxLength: 128 }
  }
};

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  }
});

const rpcError = (id, code, message) => json({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message }
});

function hasRequestId(message) {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

async function getAccessIdentity(ctx) {
  if (!ctx?.access || typeof ctx.access.getIdentity !== "function") return null;
  try {
    const identity = await ctx.access.getIdentity();
    if (!identity || typeof identity.email !== "string") return null;
    const email = identity.email.trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { email };
  } catch {
    return null;
  }
}

async function derivePrincipal(identity, env) {
  const tenantId = env?.COMPUTE_TENANT_ID;
  const projectId = env?.COMPUTE_PROJECT_ID;
  const isSafeId = (value) => typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (!identity || !isSafeId(tenantId) || !isSafeId(projectId)) return null;

  // Never forward an email address to GROUP or include it in audit records.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity.email)
  );
  const actorHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

  return {
    kind: "user",
    tenant_id: tenantId,
    project_id: projectId,
    actor_id: "access:" + actorHash,
    scopes: [...GROUP_SCOPES]
  };
}

async function readLimited(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new RangeError("request body too large");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError("request body too large");
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readResponseLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("GROUP response too large");
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function toolList() {
  return [
    {
      name: "group.health",
      description: "Read the health and dispatch-disabled status of the private GROUP control plane. This tool does not create or dispatch compute jobs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "compute_capabilities",
      description: "Read the authenticated tenant/project compute policy, quotas, enabled operations, and actual control-plane implementation status. This does not submit a Job.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "compute_submit_job",
      description: "Submit a bounded JobIntent to GROUP only when the Access-authenticated principal's tenant/project quota and operation policy permit it. QUEUED proves durable acceptance only, not execution. Reuse the same idempotency_key after timeouts or unknown outcomes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["idempotency_key", "job_intent"],
        properties: {
          idempotency_key: {
            type: "string",
            minLength: 8,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Stable key for this single JobIntent; reuse it unchanged after an unknown outcome."
          },
          job_intent: JOB_INTENT_SCHEMA
        }
      }
    },
    {
      name: "compute_get_job",
      description: "Read one Job from GROUP within the tenant/project derived from the Cloudflare Access identity. Execution results and artifacts are not implemented yet.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: { job_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }
      }
    },
    {
      name: "compute_cancel_job",
      description: "Request cancellation of a Job from GROUP within the tenant/project derived from the Cloudflare Access identity. Distinguishes terminal CANCELLED from CANCEL_REQUESTED.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: { job_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }
      }
    }
  ];
}

async function readGroupJson(response) {
  const text = await readResponseLimited(response, MAX_GROUP_RESPONSE_BYTES);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("GROUP returned an invalid JSON response");
  }
}

function encodePrincipal(principal) {
  const bytes = new TextEncoder().encode(JSON.stringify(principal));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function callGroup(env, principal, path, options = {}) {
  if (!env?.GROUP || typeof env.GROUP.fetch !== "function") {
    throw new Error("GROUP service binding is unavailable");
  }
  const headers = new Headers({
    "accept": "application/json",
    "x-symbiotyc-caller": "amphetamin",
    "x-symbiotyc-principal": encodePrincipal(principal),
    "x-correlation-id": crypto.randomUUID()
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

  const response = await env.GROUP.fetch(new Request("https://group.internal" + path, {
    method: options.method || "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  }));
  const body = await readGroupJson(response);
  return { status: response.status, ok: response.ok, body };
}

function toolTextResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError
  };
}

function toolFailure(code, message, extra = {}) {
  return toolTextResult({ error: { code, message: String(message).slice(0, 300), ...extra } }, true);
}

function groupFailure(result) {
  return toolFailure(
    result.body?.error?.code || "GROUP_REQUEST_FAILED",
    result.body?.error?.message || "GROUP rejected the request.",
    {
      http_status: result.status,
      correlation_id: result.body?.error?.correlation_id
    }
  );
}

function validateToolArguments(name, args) {
  if (!isObject(args)) return "Tool arguments must be a JSON object.";
  const allowed = {
    "group.health": [],
    compute_capabilities: [],
    compute_submit_job: ["idempotency_key", "job_intent"],
    compute_get_job: ["job_id"],
    compute_cancel_job: ["job_id"]
  }[name];
  if (!allowed) return "Unknown tool.";
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    return "Tool arguments contain an unsupported property.";
  }
  if ((name === "group.health" || name === "compute_capabilities") && Object.keys(args).length !== 0) {
    return name + " accepts no arguments.";
  }
  if (name === "compute_submit_job") {
    if (typeof args.idempotency_key !== "string" ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(args.idempotency_key)) {
      return "idempotency_key must be 8–128 safe characters and stable across retries.";
    }
    if (!isObject(args.job_intent)) return "job_intent must be a JSON object.";
    const allowedIntent = [
      "protocol", "schema_version", "operation_id", "input",
      "constraints", "output_policy", "deadline_at", "client_reference"
    ];
    if (Object.keys(args.job_intent).some((key) => !allowedIntent.includes(key))) {
      return "job_intent contains an unsupported top-level property.";
    }
    if (args.job_intent.protocol !== "symbiotyc.compute.v1" ||
        typeof args.job_intent.schema_version !== "string" ||
        !/^1\.[0-9]+$/.test(args.job_intent.schema_version) ||
        typeof args.job_intent.operation_id !== "string" ||
        !isObject(args.job_intent.input) ||
        !isObject(args.job_intent.constraints) ||
        !isObject(args.job_intent.output_policy)) {
      return "job_intent does not match the SYMBIOTYC Compute Protocol v1 shape.";
    }
  }
  if ((name === "compute_get_job" || name === "compute_cancel_job") &&
      (typeof args.job_id !== "string" || !JOB_ID_PATTERN.test(args.job_id))) {
    return "job_id must be a UUID.";
  }
  return null;
}

async function invokeTool(name, args, env, principal) {
  const invalid = validateToolArguments(name, args);
  if (invalid) return toolFailure("INVALID_ARGUMENTS", invalid);
  if (name === "group.health") {
    if (!env?.GROUP || typeof env.GROUP.fetch !== "function") {
      return toolFailure("GROUP_UNAVAILABLE", "GROUP service binding is unavailable");
    }
    try {
      const response = await env.GROUP.fetch(new Request("https://group.internal/health", {
        method: "GET",
        headers: { accept: "application/json" }
      }));
      if (!response.ok) throw new Error("GROUP health request failed");
      const body = await readGroupJson(response);
      if (body?.status !== "ok" || body?.service !== "symbiotyc-group-control-plane" ||
          body?.protocol !== "symbiotyc.compute.v1" || body?.dispatch_enabled !== false) {
        throw new Error("GROUP health response did not match the expected private contract");
      }
      return toolTextResult({
        status: body.status,
        service: body.service,
        protocol: body.protocol,
        dispatch_enabled: false
      });
    } catch {
      return toolFailure("GROUP_HEALTH_FAILED", "GROUP health check failed.");
    }
  }

  if (!principal) {
    return toolFailure("TRUSTED_PRINCIPAL_UNAVAILABLE", "Access identity could not be mapped to the configured SYMBIOTYC compute project.");
  }

  if (name === "compute_capabilities") {
    try {
      const result = await callGroup(env, principal, "/v1/capabilities");
      if (!result.ok) return groupFailure(result);
      return toolTextResult(result.body);
    } catch {
      return toolFailure("GROUP_OUTCOME_UNKNOWN", "GROUP capabilities could not be read; no state-changing operation was attempted.");
    }
  }

  if (name === "compute_submit_job") {
    let capabilities;
    try {
      const result = await callGroup(env, principal, "/v1/capabilities");
      if (!result.ok) return groupFailure(result);
      capabilities = result.body;
    } catch {
      return toolFailure("GROUP_OUTCOME_UNKNOWN", "GROUP capabilities could not be read; no Job was submitted.");
    }

    const operation = args.job_intent.operation_id;
    if (capabilities.job_submission_enabled !== true ||
        !Array.isArray(capabilities.enabled_operations) ||
        !capabilities.enabled_operations.includes(operation)) {
      return toolFailure(
        "JOB_SUBMISSION_DISABLED",
        "Job submission is disabled for this tenant/project or operation. No Job was created."
      );
    }

    try {
      const result = await callGroup(env, principal, "/v1/jobs", {
        method: "POST",
        idempotencyKey: args.idempotency_key,
        body: args.job_intent
      });
      if (!result.ok && result.status !== 202) return groupFailure(result);
      const job = result.body;
      return toolTextResult({
        ...job,
        execution_started: ["RUNNING", "SUCCEEDED", "FAILED"].includes(job.state),
        dispatch_enabled: capabilities.dispatch_enabled === true,
        acceptance_semantics: job.state === "QUEUED" ? "durably_accepted_only" : "authoritative_group_state",
        note: capabilities.dispatch_enabled === true
          ? "GROUP returned the authoritative Job state."
          : "Scheduler and Dispatcher are not enabled. QUEUED means accepted only; execution has not started.",
        idempotency_key: args.idempotency_key
      });
    } catch {
      return toolFailure(
        "JOB_ACCEPTANCE_UNKNOWN",
        "The GROUP response was lost or invalid. The Job outcome is unknown; retry or reconcile using this exact Idempotency-Key only.",
        { idempotency_key: args.idempotency_key }
      );
    }
  }

  if (name === "compute_get_job") {
    try {
      const result = await callGroup(env, principal, "/v1/jobs/" + encodeURIComponent(args.job_id));
      if (!result.ok) return groupFailure(result);
      return toolTextResult(result.body);
    } catch {
      return toolFailure("GROUP_OUTCOME_UNKNOWN", "GROUP Job state could not be read.");
    }
  }

  if (name === "compute_cancel_job") {
    try {
      const result = await callGroup(
        env, principal,
        "/v1/jobs/" + encodeURIComponent(args.job_id) + "/cancel",
        { method: "POST", body: {} }
      );
      if (!result.ok && result.status !== 202) return groupFailure(result);
      return toolTextResult({
        ...result.body,
        cancellation_semantics: result.body.state === "CANCELLED" ? "terminal_cancelled" : "cancel_requested"
      });
    } catch {
      return toolFailure("CANCELLATION_OUTCOME_UNKNOWN", "GROUP cancellation outcome is unknown; read the Job state before retrying.");
    }
  }

  return toolFailure("TOOL_NOT_FOUND", "Requested tool is not available.");
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && url.pathname !== "/health") {
    return json({ ok: false, error: "not_found" }, 404);
  }

  const identity = await getAccessIdentity(ctx);
  if (!identity) {
    return json({ ok: false, error: "access_authentication_required" }, 401, {
      "www-authenticate": "Bearer"
    });
  }

  if (url.pathname === "/health") {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return json({ ok: false, error: "application_json_required" }, 415);
  }

  let message;
  try {
    const raw = await readLimited(request);
    message = JSON.parse(raw);
  } catch (error) {
    if (error instanceof RangeError) return json({ ok: false, error: "request_too_large" }, 413);
    return rpcError(null, -32700, "Parse error");
  }
  if (
    !message || typeof message !== "object" || Array.isArray(message) ||
    message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
    (hasRequestId(message) && !["string", "number"].includes(typeof message.id))
  ) {
    return rpcError(message?.id ?? null, -32600, "Invalid Request");
  }

  const id = hasRequestId(message) ? message.id : null;
  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params
    : {};

  if (message.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (!hasRequestId(message)) {
    return new Response(null, { status: 202 });
  }

  if (message.method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      }
    });
  }
  if (message.method === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }
  if (message.method === "tools/list") {
    return json({ jsonrpc: "2.0", id, result: { tools: toolList() } });
  }
  if (message.method === "tools/call") {
    if (typeof params.name !== "string" || !isObject(params.arguments)) {
      return rpcError(id, -32602, "Invalid tool parameters");
    }
    const principal = await derivePrincipal(identity, env);
    const result = await invokeTool(params.name, params.arguments, env, principal);
    return json({ jsonrpc: "2.0", id, result });
  }
  return rpcError(id, -32601, "Method not found");
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
