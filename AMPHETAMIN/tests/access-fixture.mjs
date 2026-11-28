// Test-only Cloudflare Access fixture. The mocked ctx.access represents the
// authenticated-request context; the assertion is genuinely RS256-signed and
// verified by the same JOSE/JWKS path used in production.
export const TEST_ACCESS_ISSUER = "https://symbiotyc-test.cloudflareaccess.com";
export const TEST_ACCESS_AUDIENCE = "test-access-audience";

const testKeyPairPromise = globalThis.crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
);

const testPublicJwkPromise = testKeyPairPromise.then(async ({ publicKey }) => {
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid: "amphetamin-test-fixture", alg: "RS256", use: "sig" };
});

function encodeBytes(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeJson(value) {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export const TEST_ACCESS_JWKS_BINDING = Object.freeze({
  async fetch(input) {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname !== "/cdn-cgi/access/certs") {
      return new Response("not found", { status: 404 });
    }
    return Response.json({ keys: [await testPublicJwkPromise] });
  }
});

export async function attachTestAccessAssertion(request, {
  issuer = TEST_ACCESS_ISSUER,
  subject = "access-owner-1",
  audience = TEST_ACCESS_AUDIENCE,
  exp = Math.floor(Date.now() / 1000) + 300,
  nbf = Math.floor(Date.now() / 1000) - 30,
  type = "app",
  email
} = {}) {
  const { privateKey } = await testKeyPairPromise;
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: "amphetamin-test-fixture" });
  const payload = encodeJson({
    iss: issuer,
    sub: subject,
    aud: [audience],
    exp,
    nbf,
    iat: Math.floor(Date.now() / 1000),
    type,
    ...(typeof email === "string" ? { email } : {})
  });
  const signingInput = `${header}.${payload}`;
  const signature = await globalThis.crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const headers = new Headers(request.headers);
  headers.set("cf-access-jwt-assertion", `${signingInput}.${encodeBytes(signature)}`);
  return new Request(request, { headers });
}

export async function callWithTestAccess(handler, request, env, ctx) {
  if (!ctx?.access || typeof ctx.access.getIdentity !== "function") {
    return handler(request, env, ctx);
  }
  let identity = null;
  try {
    identity = await ctx.access.getIdentity();
  } catch {
    // The real handler exercises the fail-closed path for a rejected identity.
  }
  const issuer = env?.CLOUDFLARE_ACCESS_ISSUER ?? TEST_ACCESS_ISSUER;
  const audience = typeof ctx.access.aud === "string"
    ? ctx.access.aud
    : TEST_ACCESS_AUDIENCE;
  const subject = typeof identity?.id === "string" ? identity.id : "";
  return handler(
    await attachTestAccessAssertion(request, {
      issuer,
      audience,
      subject,
      email: typeof identity?.email === "string" ? identity.email : undefined
    }),
    {
      ...env,
      CLOUDFLARE_ACCESS_ISSUER: issuer,
      ACCESS_JWKS_TEST: TEST_ACCESS_JWKS_BINDING
    },
    ctx
  );
}
