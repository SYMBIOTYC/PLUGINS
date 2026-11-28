import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { handleRequest } from "../src/index.mjs";
import { FakeD1 } from "./fake-d1.mjs";

const crypto = webcrypto;
const encoder = new TextEncoder();
const AUD = "amphetamin-test-audience";
const ISSUER_A = "https://tenant-a.cloudflareaccess.com";
const ISSUER_B = "https://tenant-b.cloudflareaccess.com";

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
publicJwk.kid = "amphetamin-test-key";
publicJwk.alg = "RS256";
publicJwk.use = "sig";

function base64url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function signAccessJwt({
  issuer = ISSUER_A,
  subject = "stable-user-subject",
  audience = AUD,
  email = "owner@example.invalid",
  exp = Math.floor(Date.now() / 1000) + 300,
  nbf = Math.floor(Date.now() / 1000) - 30,
  overrides = {}
} = {}) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: publicJwk.kid }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    sub: subject,
    aud: [audience],
    email,
    exp,
    nbf,
    iat: Math.floor(Date.now() / 1000),
    type: "app",
    ...overrides
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    encoder.encode(signingInput)
  );
  return `${signingInput}.${base64url(signature)}`;
}

function accessContext(subject = "stable-user-subject", email = "owner@example.invalid", identityId = subject) {
  return {
    access: {
      aud: AUD,
      getIdentity: async () => ({
        id: identityId,
        email,
        tenant_id: "attacker-tenant",
        project_id: "attacker-project",
        actor_id: "attacker-actor",
        scopes: ["compute:admin"]
      })
    }
  };
}

function rpcRequest(token) {
  return new Request("https://amphetamin.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Jwt-Assertion": token
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "issuer-scope-test",
      method: "tools/call",
      params: { name: "compute_capabilities", arguments: {} }
    })
  });
}

function decodePrincipal(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function withAccessJwks(callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/cdn-cgi/access/certs") {
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function invokeWithIssuer({ issuer, email = "owner@example.invalid", env = {}, subject = "stable-user-subject", identityId = subject }) {
  const token = await signAccessJwt({ issuer, subject, email });
  const db = new FakeD1();
  let groupPrincipal = null;
  const fullEnv = {
    CLOUDFLARE_ACCESS_ISSUER: issuer,
    COMPUTE_TENANT_ID: "tenant-from-deployment",
    COMPUTE_PROJECT_ID: "project-from-deployment",
    RUNTIME_DB: db,
    ...env,
    GROUP: {
      fetch: async (request) => {
        const encoded = request.headers.get("x-symbiotyc-principal");
        if (encoded) groupPrincipal = decodePrincipal(encoded);
        return Response.json({ ok: true, activation_remaining_minutes: 0, deployment_streak: 0, burnout_score: 0, version: 1 });
      }
    }
  };
  const response = await handleRequest(rpcRequest(token), fullEnv, accessContext(subject, email, identityId));
  return { response, db, groupPrincipal };
}

test("canonical actor identity is issuer plus immutable JWT subject, not Access audience or email", async () => {
  await withAccessJwks(async () => {
    const a = await invokeWithIssuer({ issuer: ISSUER_A, email: "first-address@example.invalid" });
    const b = await invokeWithIssuer({ issuer: ISSUER_B, email: "first-address@example.invalid" });
    assert.ok(a.groupPrincipal, "AMPHETAMIN must send the derived principal to GROUP");
    assert.ok(b.groupPrincipal, "AMPHETAMIN must send the derived principal to GROUP");

    const expectedA = createHash("sha256").update(`${ISSUER_A}\u0000stable-user-subject`).digest("hex");
    const expectedB = createHash("sha256").update(`${ISSUER_B}\u0000stable-user-subject`).digest("hex");
    assert.equal(a.groupPrincipal.actor_id, `access:${expectedA}`);
    assert.equal(b.groupPrincipal.actor_id, `access:${expectedB}`);
    assert.notEqual(a.groupPrincipal.actor_id, b.groupPrincipal.actor_id);
  });
});

test("changing email does not change actor identity when issuer and subject remain stable", async () => {
  await withAccessJwks(async () => {
    const first = await invokeWithIssuer({ issuer: ISSUER_A, email: "before@example.invalid", identityId: "different-identity-object-id-a" });
    const second = await invokeWithIssuer({ issuer: ISSUER_A, email: "after@example.invalid", identityId: "different-identity-object-id-b" });
    assert.ok(first.groupPrincipal);
    assert.ok(second.groupPrincipal);
    assert.equal(first.groupPrincipal.actor_id, second.groupPrincipal.actor_id);
  });
});

test("caller-supplied tenant, project, actor, and scopes never override trusted derivation", async () => {
  await withAccessJwks(async () => {
    const result = await invokeWithIssuer({ issuer: ISSUER_A });
    assert.ok(result.groupPrincipal);
    assert.equal(result.groupPrincipal.tenant_id, "tenant-from-deployment");
    assert.equal(result.groupPrincipal.project_id, "project-from-deployment");
    assert.equal(result.groupPrincipal.kind, "user");
    assert.notEqual(result.groupPrincipal.actor_id, "attacker-actor");
    assert.deepEqual(result.groupPrincipal.scopes, ["compute:read", "compute:jobs:read"]);
    assert.notEqual(result.groupPrincipal.actor_id, "attacker-actor");
  });
});

test("email-only Access assertion without a signed immutable subject is rejected", async () => {
  const token = await signAccessJwt({ issuer: ISSUER_A, subject: "", email: "email-only@example.invalid" });
  const response = await handleRequest(
    rpcRequest(token),
    {
      CLOUDFLARE_ACCESS_ISSUER: ISSUER_A,
      COMPUTE_TENANT_ID: "tenant",
      COMPUTE_PROJECT_ID: "project"
    },
    { access: { aud: AUD } }
  );
  assert.equal(response.status, 401);
});

test("WARP-style Access context with only aud still resolves the signed issuer and subject", async () => {
  const token = await signAccessJwt({ issuer: ISSUER_A, subject: "warp-user-subject" });
  let principal = null;
  const response = await handleRequest(rpcRequest(token), {
    CLOUDFLARE_ACCESS_ISSUER: ISSUER_A,
    COMPUTE_TENANT_ID: "tenant",
    COMPUTE_PROJECT_ID: "project",
    RUNTIME_DB: new FakeD1(),
    GROUP: {
      fetch: async (request) => {
        const encoded = request.headers.get("x-symbiotyc-principal");
        if (encoded) principal = decodePrincipal(encoded);
        return Response.json({ ok: true });
      }
    }
  }, { access: { aud: AUD } });
  assert.equal(response.status, 200);
  assert.equal(principal.actor_id, `access:${createHash("sha256").update(ISSUER_A + String.fromCharCode(0) + "warp-user-subject").digest("hex")}`);
});

test("issuer mismatch, audience mismatch, expiry, and missing subject fail closed", async () => {
  await withAccessJwks(async () => {
    const validToken = await signAccessJwt({ issuer: ISSUER_A });
    const tamperedParts = validToken.split(".");
    tamperedParts[2] = `${tamperedParts[2][0] === "A" ? "B" : "A"}${tamperedParts[2].slice(1)}`;
    const cases = [
      { label: "wrong issuer", token: await signAccessJwt({ issuer: ISSUER_B }) },
      { label: "wrong audience", token: await signAccessJwt({ audience: "another-audience" }) },
      { label: "expired token", token: await signAccessJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) },
      { label: "missing subject", token: await signAccessJwt({ subject: "" }) },
      { label: "malformed token", token: "not-a-jwt" },
      { label: "invalid signature", token: tamperedParts.join(".") }
    ];
    for (const item of cases) {
      const response = await handleRequest(rpcRequest(item.token), {
        CLOUDFLARE_ACCESS_ISSUER: ISSUER_A,
        COMPUTE_TENANT_ID: "tenant",
        COMPUTE_PROJECT_ID: "project"
      }, accessContext());
      assert.equal(response.status, 401, item.label);
    }
  });
});

test("missing trusted Access issuer configuration fails closed", async () => {
  const token = await signAccessJwt({ issuer: ISSUER_A });
  const response = await handleRequest(rpcRequest(token), {
    COMPUTE_TENANT_ID: "tenant",
    COMPUTE_PROJECT_ID: "project"
  }, accessContext());
  assert.equal(response.status, 401);
});

test("missing trusted project mapping fails closed before invoking GROUP", async () => {
  await withAccessJwks(async () => {
    let groupCalled = false;
    const token = await signAccessJwt({ issuer: ISSUER_A });
    const response = await handleRequest(rpcRequest(token), {
      CLOUDFLARE_ACCESS_ISSUER: ISSUER_A,
      COMPUTE_TENANT_ID: "tenant-from-deployment",
      RUNTIME_DB: new FakeD1(),
      GROUP: { fetch: async () => { groupCalled = true; return Response.json({}); } }
    }, accessContext());
    const payload = await response.json();
    assert.equal(groupCalled, false);
    assert.equal(payload.result.isError, true);
    assert.match(payload.result.content[0].text, /PROJECT_MAPPING_UNAVAILABLE/);
  });
});
