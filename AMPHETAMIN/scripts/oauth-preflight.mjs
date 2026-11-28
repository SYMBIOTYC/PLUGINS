import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function parseBearerChallenge(header) {
  if (typeof header !== "string" || !header.trim()) {
    throw new Error("Missing WWW-Authenticate header");
  }
  const match = header.match(/^\s*Bearer\s+(.+)$/i);
  if (!match) throw new Error("WWW-Authenticate must use the Bearer scheme");

  const parameters = {};
  const expression = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  let item;
  while ((item = expression.exec(match[1])) !== null) {
    parameters[item[1].toLowerCase()] = (item[2] ?? item[3]).replace(/\\(["\\])/g, "$1");
  }
  if (!parameters.resource_metadata) {
    throw new Error("Bearer challenge does not advertise resource_metadata");
  }
  return { scheme: "Bearer", parameters };
}

function requireHttpsUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${field} URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${field} must be an HTTPS URL without embedded credentials`);
  }
  return parsed;
}

export function validateOAuthDiscovery({
  resourceMetadata,
  authorizationServerMetadata,
  expectedResource
}) {
  if (!resourceMetadata || typeof resourceMetadata !== "object") {
    throw new Error("Protected Resource Metadata must be a JSON object");
  }
  if (!Array.isArray(resourceMetadata.authorization_servers) ||
      resourceMetadata.authorization_servers.length === 0) {
    throw new Error("Protected Resource Metadata must list authorization_servers");
  }

  requireHttpsUrl(expectedResource, "expected resource");
  requireHttpsUrl(resourceMetadata.resource, "resource");
  if (resourceMetadata.resource !== expectedResource) {
    throw new Error(`Protected Resource Metadata resource mismatch: advertised=${resourceMetadata.resource}; expected=${expectedResource}`);
  }

  const metadata = authorizationServerMetadata;
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Authorization Server Metadata must be a JSON object");
  }
  requireHttpsUrl(metadata.issuer, "issuer");
  const advertisedIssuers = resourceMetadata.authorization_servers;
  if (!advertisedIssuers.includes(metadata.issuer)) {
    throw new Error("Authorization Server Metadata issuer is not listed in authorization_servers");
  }

  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    requireHttpsUrl(metadata[field], field);
  }
  if (!Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
      metadata.token_endpoint_auth_methods_supported.length === 0) {
    throw new Error("Authorization Server Metadata must list token_endpoint_auth_methods_supported");
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) ||
      !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("Authorization Server Metadata must advertise PKCE S256");
  }

  const scopes = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [];
  return {
    issuer: metadata.issuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint,
    token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
    pkce_s256: true,
    dcr: true,
    offline_access: scopes.includes("offline_access"),
    authorization_response_iss_parameter_supported:
      metadata.authorization_response_iss_parameter_supported === true
  };
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual"
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} did not return application/json`);
  }
  return response.json();
}

export async function runOAuthPreflight({
  endpoint,
  fetchImpl = fetch
}) {
  const mcp = requireHttpsUrl(endpoint, "MCP endpoint");
  const response = await fetchImpl(mcp.href, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "oauth-preflight",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "symbiotyc-oauth-preflight", version: "1.0.0" }
      }
    }),
    redirect: "manual"
  });

  if (response.status !== 401) {
    throw new Error(`Unauthenticated MCP request must receive HTTP 401; received ${response.status}`);
  }

  const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
  const resourceMetadataUrl = requireHttpsUrl(
    challenge.parameters.resource_metadata,
    "resource_metadata"
  );
  const resourceMetadata = await fetchJson(fetchImpl, resourceMetadataUrl.href, "Protected Resource Metadata");

  if (!Array.isArray(resourceMetadata.authorization_servers) ||
      resourceMetadata.authorization_servers.length === 0) {
    throw new Error("Protected Resource Metadata does not identify an authorization server");
  }

  const issuerValue = resourceMetadata.authorization_servers[0];
  const issuer = requireHttpsUrl(issuerValue, "authorization server issuer");
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", issuer);
  const authorizationServerMetadata = await fetchJson(
    fetchImpl,
    metadataUrl.href,
    "Authorization Server Metadata"
  );

  const discovery = validateOAuthDiscovery({
    resourceMetadata,
    authorizationServerMetadata,
    expectedResource: mcp.origin
  });

  return {
    endpoint: mcp.href,
    unauthenticated_status: response.status,
    resource_metadata_url: resourceMetadataUrl.href,
    authorization_server_metadata_url: metadataUrl.href,
    ...discovery,
    refresh_token_scope_advertised: discovery.offline_access,
    resource_parameter_exchange: "not tested (would require authorization/token exchange)",
    dcr_registration: "not executed (read-only preflight)"
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const endpoint = process.env.AMPHETAMIN_MCP_ENDPOINT ||
    "https://symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev/mcp";
  try {
    const report = await runOAuthPreflight({ endpoint });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.refresh_token_scope_advertised) {
      process.stderr.write("WARNING: offline_access is not advertised; token refresh may require reauthorization.\n");
    }
  } catch (error) {
    process.stderr.write(`OAuth preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
