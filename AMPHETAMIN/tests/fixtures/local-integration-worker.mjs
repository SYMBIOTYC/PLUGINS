import { handleRequest } from "../../src/index.mjs";
import { attachTestAccessAssertion, TEST_ACCESS_ISSUER, TEST_ACCESS_AUDIENCE } from "../access-fixture.mjs";

// This entrypoint exists only for local integration tests. It supplies a
// deterministic Access context and matching test assertion; production Access
// policy and the production Worker entrypoint are not modified.
export default {
  fetch(request, env, ctx) {
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
      attachTestAccessAssertion(request, {
        issuer: TEST_ACCESS_ISSUER,
        audience: TEST_ACCESS_AUDIENCE,
        subject: "local-integration-owner"
      }),
      { ...env, CLOUDFLARE_ACCESS_ISSUER: TEST_ACCESS_ISSUER },
      { ...ctx, access }
    );
  }
};
