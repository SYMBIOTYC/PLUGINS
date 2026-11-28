const SERVICE = "amphetamin-mcp";
const PROTOCOL_VERSION = "2026-07-28";
const MAX_MCP_BODY_BYTES = 96 * 1024;
const MAX_GROUP_RESPONSE_BYTES = 128 * 1024;
const GROUP_SCOPES = Object.freeze([
  "compute:jobs:read",
  "compute:jobs:write",
  "compute:jobs:cancel"
]);

const tools = [
  {
    name: "compute_capabilities",
    description: "Read the authenticated tenant/project compute policy, quotas, enabled operations, and actual control-plane implementation status. This does not submit a Job.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }
  },
  {
    name: "compute_submit_job",
    description: "Submit a bounded JobIntent to GROUP only when the tenant/project quota and operation policy permit it. A QUEUED response proves durable acceptance only; it does not mean that execution started or completed. Reuse the same idempotency_key when resolving an unknown outcome.",
    inputSchema: {
      type: "object",
      required: ["idempotency_key", "job_intent"],
      additionalProperties: false,
      properties: {
        idempotency_key: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
          description: "Stable key for this single JobIntent. Reuse exactly this key after timeouts or unknown outcomes."
        },
        job_intent: {
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
              properties: {
                worker_pool: { enum: ["CLOUD-COMPUTE", "CLOUD-CPU", "CLOUD-VPS"] },
                required_capabilities: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } },
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
                media_types: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } }
              }
            },
            deadline_at: { type: "string", format: "date-time" },
            client_reference: { type: "string", maxLength: 128 }
          }
        }
      }
    }
  },
  {
    name: "compute_get_job",
    description: "Read one Job from GROUP within the server-derived tenant and project. This returns lifecycle state only; execution results and artifacts are not implemented yet.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      additionalProperties: false,
      properties: { job_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }
    }
  },
  {
    name: "compute_cancel_job",
    description: "Request cancellation of a Job in GROUP within the server-derived tenant and project. The response distinguishes terminal CANCELLED from CANCEL_REQUESTED.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      additionalProperties: false,
      properties: { job_id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }
    }
  }
];

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function rpcError(id, status, code, message) {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message: String(message).slice(0, 300) }
  });
}

function rpcResult(id, result, status = 200) {
  return jsonResponse(status, { jsonrpc: "2.0", id, result });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

async function readJsonLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("request body is required");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("MCP request exceeds the size limit");
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

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = String(env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function validateTransport(request, message) {
  const accept = (request.headers.get("accept") || "")
    .split(",")
    .map((value) => value.split(";")[0].trim().toLowerCase());
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return { status: 406, code: -32020, message: "Accept must include application/json and text/event-stream." };
  }
  const protocolHeader = request.headers.get("mcp-protocol-version");
  const protocolBody = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (!protocolHeader || !protocolBody || protocolHeader !== protocolBody) {
    return { status: 400, code: -32020, message: "MCP-Protocol-Version must match request metadata." };
  }
  if (protocolHeader !== PROTOCOL_VERSION) {
    return { status: 400, code: -32022, message: "Unsupported protocol version. Supported versions: " + PROTOCOL_VERSION };
  }
  if (request.headers.get("mcp-method") !== message.method) {
    return { status: 400, code: -32020, message: "Mcp-Method does not match the JSON-RPC method." };
  }
  if (message.method === "tools/call" &&
      request.headers.get("mcp-name") !== message.params?.name) {
    return { status: 400, code: -32020, message: "Mcp-Name does not match params.name." };
  }
  return null;
}

function encodePrincipal(principal) {
  const bytes = new TextEncoder().encode(JSON.stringify(principal));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function derivePrincipal(env) {
  const tenant = env.TENANT_ID;
  const project = env.PROJECT_ID;
  const actor = env.ACTOR_ID;
  const safeId = (value) => typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (!safeId(tenant) || !safeId(project) || !safeId(actor)) return null;
  return {
    kind: "service",
    tenant_id: tenant,
    project_id: project,
    actor_id: actor,
    scopes: [...GROUP_SCOPES]
  };
}

function toolSuccess(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolFailure(code, message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message: String(message).slice(0, 300), ...extra } }) }]
  };
}

function validateArgs(name, args) {
  if (!isObject(args)) return "Tool arguments must be a JSON object.";
  const allowed = {
    compute_capabilities: [],
    compute_submit_job: ["idempotency_key", "job_intent"],
    compute_get_job: ["job_id"],
    compute_cancel_job: ["job_id"]
  }[name];
  if (!allowed) return "Unknown compute tool.";
  if (Object.keys(args).some((key) => !allowed.includes(key))) return "Tool arguments contain an unsupported property.";
  if (name === "compute_capabilities" && Object.keys(args).length !== 0) return "compute_capabilities accepts no arguments.";
  if (name === "compute_submit_job") {
    if (typeof args.idempotency_key !== "string" ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(args.idempotency_key)) {
      return "idempotency_key must be 8–128 safe characters and stable across retries.";
    }
    if (!isObject(args.job_intent)) return "job_intent must be a JSON object.";
  }
  if ((name === "compute_get_job" || name === "compute_cancel_job") &&
      (typeof args.job_id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(args.job_id))) {
    return "job_id must be a UUID.";
  }
  return null;
}

async function readGroupJson(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_GROUP_RESPONSE_BYTES) {
    throw new RangeError("GROUP response exceeded the response-size limit");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new TypeError("GROUP returned a non-JSON response");
  }
}

async function callGroup(env, principal, path, options = {}) {
  if (!env.GROUP || typeof env.GROUP.fetch !== "function") {
    throw new Error("GROUP Service Binding is not configured.");
  }
  const headers = new Headers({
    accept: "application/json",
    "x-symbiotyc-caller": "amphetamin",
    "x-symbiotyc-principal": encodePrincipal(principal),
    "x-correlation-id": crypto.randomUUID()
  });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  const response = await env.GROUP.fetch(new Request("https://group" + path, {
    method: options.method || "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  }));
  const body = await readGroupJson(response);
  return { status: response.status, ok: response.ok, body };
}

function groupFailure(result) {
  const code = result.body?.error?.code || "GROUP_REQUEST_FAILED";
  const message = result.body?.error?.message || "GROUP rejected the request.";
  return toolFailure(code, message, {
    http_status: result.status,
    correlation_id: result.body?.error?.correlation_id
  });
}

async function invokeTool(name, args, env, principal) {
  const invalid = validateArgs(name, args);
  if (invalid) return toolFailure("INVALID_ARGUMENTS", invalid);
  if (!principal) return toolFailure("TRUSTED_PRINCIPAL_UNAVAILABLE", "AMPHETAMIN service principal configuration is incomplete.");
  if (!env.GROUP || typeof env.GROUP.fetch !== "function") {
    return toolFailure("GROUP_UNAVAILABLE", "GROUP Service Binding is not configured.");
  }

  if (name === "compute_capabilities") {
    try {
      const result = await callGroup(env, principal, "/v1/capabilities");
      if (!result.ok) return groupFailure(result);
      return toolSuccess(result.body);
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
      if (!result.ok && result.status !== 202) {
        return groupFailure(result);
      }
      const job = result.body;
      return toolSuccess({
        ...job,
        execution_started: ["RUNNING", "SUCCEEDED", "FAILED"].includes(job.state),
        dispatch_enabled: capabilities.dispatch_enabled === true,
        acceptance_semantics: job.state === "QUEUED"
          ? "durably_accepted_only"
          : "authoritative_group_state",
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
      return toolSuccess(result.body);
    } catch {
      return toolFailure("GROUP_OUTCOME_UNKNOWN", "GROUP Job state could not be read.");
    }
  }

  if (name === "compute_cancel_job") {
    try {
      const result = await callGroup(env, principal, "/v1/jobs/" + encodeURIComponent(args.job_id) + "/cancel", { method: "POST", body: {} });
      if (!result.ok && result.status !== 202) return groupFailure(result);
      return toolSuccess({
        ...result.body,
        cancellation_semantics: result.body.state === "CANCELLED" ? "terminal_cancelled" : "cancel_requested"
      });
    } catch {
      return toolFailure("CANCELLATION_OUTCOME_UNKNOWN", "GROUP cancellation outcome is unknown; read the Job state before retrying.");
    }
  }

  return toolFailure("TOOL_NOT_FOUND", "Requested compute tool is not available.");
}

async function handleMcp(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Streamable HTTP accepts POST only." }, { allow: "POST" });
  }
  if (!isAllowedOrigin(request, env)) {
    return jsonResponse(403, { error: "Origin is not permitted for this private MCP endpoint." });
  }
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    return jsonResponse(415, { error: "MCP messages must use application/json." });
  }

  let message;
  try {
    message = await readJsonLimited(request);
  } catch {
    return rpcError(null, 400, -32600, "MCP request body is invalid or exceeds the size limit.");
  }
  if (!isObject(message) || message.jsonrpc !== "2.0" ||
      (typeof message.id !== "string" && !Number.isSafeInteger(message.id)) ||
      typeof message.method !== "string" || !isObject(message.params)) {
    return rpcError(message?.id, 400, -32600, "A single JSON-RPC 2.0 request with id and params is required.");
  }

  const transportError = validateTransport(request, message);
  if (transportError) return rpcError(message.id, transportError.status, transportError.code, transportError.message);

  if (message.method === "ping") return rpcResult(message.id, {});
  if (message.method === "tools/list") return rpcResult(message.id, { tools });
  if (message.method !== "tools/call") {
    return rpcError(message.id, 404, -32601, "Method not found.");
  }
  const name = message.params.name;
  if (typeof name !== "string" || !tools.some((item) => item.name === name)) {
    return rpcError(message.id, 400, -32602, "Unknown tool name.");
  }

  const principal = derivePrincipal(env);
  const result = await invokeTool(name, message.params.arguments ?? {}, env, principal);
  return rpcResult(message.id, result);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        service: SERVICE,
        protocol_version: PROTOCOL_VERSION,
        transport: "streamable-http-stateless",
        dispatch_enabled: false,
        public_ingress: false
      });
    }
    if (url.pathname === "/mcp") return handleMcp(request, env);
    return jsonResponse(404, { error: "Route not found." });
  }
};
