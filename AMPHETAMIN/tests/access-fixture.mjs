// Test-only Access context adapter. The mocked ctx.access represents Cloudflare's
// authenticated-request attestation; production code still requires the Access JWT
// claims and checks issuer, audience, subject, expiry, and token type.
export const TEST_ACCESS_ISSUER = "https://symbiotyc-test.cloudflareaccess.com";
export const TEST_ACCESS_AUDIENCE = "test-access-audience";

function encodeJson(value) {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function attachTestAccessAssertion(request, {
  issuer = TEST_ACCESS_ISSUER,
  subject = "access-owner-1",
  audience = TEST_ACCESS_AUDIENCE,
  exp = Math.floor(Date.now() / 1000) + 300,
  nbf = Math.floor(Date.now() / 1000) - 30,
  type = "app"
} = {}) {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: "test-only" });
  const payload = encodeJson({
    iss: issuer,
    sub: subject,
    aud: [audience],
    exp,
    nbf,
    iat: Math.floor(Date.now() / 1000),
    type
  });
  const headers = new Headers(request.headers);
  headers.set("cf-access-jwt-assertion", `${header}.${payload}.test-only-signature`);
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
    attachTestAccessAssertion(request, { issuer, audience, subject }),
    { ...env, CLOUDFLARE_ACCESS_ISSUER: issuer },
    ctx
  );
}
