export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_GROUP_RESPONSE_BYTES = 8 * 1024;
const SERVER_INFO = Object.freeze({
  name: "symbiotyc-amphetamin",
  version: "0.1.0"
});
const PROTOCOL_VERSION = "2025-03-26";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
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

async function hasAccessIdentity(ctx) {
  if (!ctx?.access || typeof ctx.access.getIdentity !== "function") return false;
  try {
    const identity = await ctx.access.getIdentity();
    return Boolean(identity && typeof identity.email === "string" && identity.email.length > 0);
  } catch {
    return false;
  }
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
    description: "Read the health and dispatch-disabled status of the private GROUP control plane. This tool does not create or dispatch compute jobs.",
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
  if (!await hasAccessIdentity(ctx)) {
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
      const result = await readGroupHealth(env);
      return json({ jsonrpc: "2.0", id, result: toolTextResult(result) });
    } catch (error) {
      const message = error instanceof Error && error.message === "GROUP service binding is unavailable"
        ? error.message
        : "GROUP health check failed";
      return json({
        jsonrpc: "2.0",
        id,
        result: toolTextResult({ ok: false, error: message }, true)
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
