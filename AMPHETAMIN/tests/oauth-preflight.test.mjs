import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBearerChallenge,
  validateOAuthDiscovery
} from "../scripts/oauth-preflight.mjs";

test("parses quoted resource_metadata from a Bearer challenge", () => {
  const challenge = parseBearerChallenge(
    'Bearer realm="Cloudflare Access", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="compute:read"'
  );
  assert.equal(challenge.scheme, "Bearer");
  assert.equal(challenge.parameters.resource_metadata,
    "https://mcp.example/.well-known/oauth-protected-resource/mcp");
  assert.equal(challenge.parameters.scope, "compute:read");
});

test("rejects missing or non-Bearer discovery challenges", () => {
  assert.throws(() => parseBearerChallenge(null), /WWW-Authenticate/);
  assert.throws(() => parseBearerChallenge("Basic realm=\"x\""), /Bearer/);
  assert.throws(() => parseBearerChallenge("Bearer realm=\"x\""), /resource_metadata/);
});

test("accepts OAuth discovery with S256 and DCR", () => {
  const result = validateOAuthDiscovery({
    resourceMetadata: {
      resource: "https://mcp.example/mcp",
      authorization_servers: ["https://mcp.example"]
    },
    authorizationServerMetadata: {
      issuer: "https://mcp.example",
      authorization_endpoint: "https://mcp.example/cdn-cgi/access/authorize",
      token_endpoint: "https://mcp.example/cdn-cgi/access/token",
      registration_endpoint: "https://mcp.example/cdn-cgi/access/register",
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "email", "offline_access"]
    },
    expectedResource: "https://mcp.example/mcp"
  });
  assert.equal(result.pkce_s256, true);
  assert.equal(result.dcr, true);
  assert.equal(result.offline_access, true);
});

test("rejects issuer mismatch, missing PKCE S256, and missing DCR endpoint", () => {
  assert.throws(() => validateOAuthDiscovery({
    resourceMetadata: { resource: "https://mcp.example/mcp", authorization_servers: ["https://expected-issuer.example"] },
    authorizationServerMetadata: { issuer: "https://other.example", authorization_endpoint: "https://other.example/a", token_endpoint: "https://other.example/t", registration_endpoint: "https://other.example/r", token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] },
    expectedResource: "https://mcp.example/mcp"
  }), /issuer/);

  assert.throws(() => validateOAuthDiscovery({
    resourceMetadata: { resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] },
    authorizationServerMetadata: { issuer: "https://mcp.example", authorization_endpoint: "https://mcp.example/a", token_endpoint: "https://mcp.example/t", registration_endpoint: "https://mcp.example/r", token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["plain"] },
    expectedResource: "https://mcp.example/mcp"
  }), /S256/);

  assert.throws(() => validateOAuthDiscovery({
    resourceMetadata: { resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] },
    authorizationServerMetadata: { issuer: "https://mcp.example", authorization_endpoint: "https://mcp.example/a", token_endpoint: "https://mcp.example/t", token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] },
    expectedResource: "https://mcp.example/mcp"
  }), /registration_endpoint/);
});
