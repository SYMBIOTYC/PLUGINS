import { handleRequest } from "../../src/index.mjs";
import {
  attachTestAccessAssertion,
  TEST_ACCESS_ISSUER,
  TEST_ACCESS_AUDIENCE,
  TEST_ACCESS_JWKS_BINDING
} from "../access-fixture.mjs";

// This entrypoint exists only for local integration tests. It supplies a
// deterministic Access context and a genuinely signed assertion backed by the
// test-only JWKS binding; production Access and Worker configuration are untouched.
export default {
  async fetch(request, env, ctx) {
    const access = {
      aud: TEST_ACCESS_AUDIENCE,
      async getIdentity() {
        return {
          id: "local-integration-owner",
          email: "local-integration@example.invalid"
        };
      }
    };
    return handleRequest(
      await attachTestAccessAssertion(request, {
        issuer: TEST_ACCESS_ISSUER,
        audience: TEST_ACCESS_AUDIENCE,
        subject: "local-integration-owner",
        email: "local-integration@example.invalid"
      }),
      {
        ...env,
        CLOUDFLARE_ACCESS_ISSUER: TEST_ACCESS_ISSUER,
        ACCESS_JWKS_TEST: TEST_ACCESS_JWKS_BINDING
      },
      { ...ctx, access }
    );
  }
};
