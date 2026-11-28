import { D1AuditSink, D1IdempotencyStore } from "./runtime/d1-adapters.mjs";
import { ToolRuntime } from "./runtime/tool-runtime.mjs";
import { SkillRuntime } from "./runtime/skill-runtime.mjs";
import { TOOL_REGISTRY, SKILL_REGISTRY, SKILL_DEFINITIONS } from "./runtime/registry.mjs";

export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_GROUP_RESPONSE_BYTES = 8 * 1024;
const SERVER_INFO = Object.freeze({
  name: "symbiotyc-amphetamin",
  version: "0.2.0"
});
const PROTOCOL_VERSION = "2025-03-26";

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
    return identity && typeof identity.email === "string" && identity.email.length > 0
      ? identity
      : null;
  } catch {
    return null;
  }
}

async function derivePrincipal(identity, env) {
  const stableSubject = typeof identity.id === "string" && identity.id
    ? identity.id
    : identity.email.trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableSubject));
  const actorHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    tenant_id: env.TENANT_ID || "symbiotyc-owner",
    actor_id: `access:${actorHash}`,
    scopes: ["compute:read"]
  };
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function toolList() {
  return [{
    name: "group.health",
    description: "Run the verified read-only GROUP health Skill through the Tool/Skill Runtime. This operation does not create or dispatch compute jobs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }];
}

async function readGroupHealth(env) {
  if (!env?.GROUP || typeof env.GROUP.fetch !== "function") {
    throw new Error("GROUP service binding is unavailable");
  }
  const response = await env.GROUP.fetch(new Request("https://group.internal/health", {
    method: "GET",
    headers: { "accept": "application/json" }
  }));
  if (!response.ok) throw new Error("GROUP health request failed");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_GROUP_RESPONSE_BYTES) {
    throw new Error("GROUP health response exceeded its size limit");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("GROUP returned an invalid health response");
  }
  if (
    value?.status !== "ok" ||
    value?.service !== "symbiotyc-group-control-plane" ||
    value?.protocol !== "symbiotyc.compute.v1" ||
    value?.dispatch_enabled !== false
  ) {
    throw new Error("GROUP health response did not match the expected private control-plane contract");
  }
  return {
    status: value.status,
    service: value.service,
    protocol: value.protocol,
    dispatch_enabled: false
  };
}

async function executeGroupHealth(env, principal, requestId) {
  if (!env?.RUNTIME_DB || typeof env.RUNTIME_DB.prepare !== "function") {
    throw new Error("durable Tool/Skill Runtime database binding is unavailable");
  }
  const audit = new D1AuditSink(env.RUNTIME_DB);
  const toolRuntime = new ToolRuntime(
    TOOL_REGISTRY,
    { "symbiotyc.group:health": async () => readGroupHealth(env) },
    {
      idempotencyStore: new D1IdempotencyStore(env.RUNTIME_DB, "tool"),
      auditSink: (event) => audit.append(event)
    }
  );
  const skillRuntime = new SkillRuntime(
    toolRuntime,
    SKILL_REGISTRY,
    SKILL_DEFINITIONS,
    {
      idempotencyStore: new D1IdempotencyStore(env.RUNTIME_DB, "skill"),
      auditSink: (event) => audit.append(event)
    }
  );
  const requestHash = await sha256Text(String(requestId));
  const timeBucket = Math.floor(Date.now() / 30000);
  const idempotencyKey = `mcp:${principal.actor_id.slice(-24)}:${requestHash.slice(0, 16)}:${timeBucket}`;
  const run = await skillRuntime.run({
    schema_version: "1.0",
    run_id: crypto.randomUUID(),
    skill_id: "skill.symbiotyc.group-health",
    idempotency_key: idempotencyKey,
    input: {}
  }, principal);
  return run.result;
}

function toolTextResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError
  };
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
    return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, runtime: "tool-skill-v1" });
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
    if (typeof params.name !== "string" || !params.arguments ||
        typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
      return rpcError(id, -32602, "Invalid tool parameters");
    }
    if (params.name !== "group.health") {
      return rpcError(id, -32602, "Unknown tool");
    }
    if (Object.keys(params.arguments).length !== 0) {
      return rpcError(id, -32602, "group.health accepts no arguments");
    }
    try {
      const principal = await derivePrincipal(identity, env);
      const result = await executeGroupHealth(env, principal, id);
      return json({ jsonrpc: "2.0", id, result: toolTextResult(result) });
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "RUNTIME_EXECUTION_FAILED";
      return json({
        jsonrpc: "2.0",
        id,
        result: toolTextResult({ ok: false, error: code }, true)
      });
    }
  }
  return rpcError(id, -32601, "Method not found");
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
