import { handleRequest } from "../../src/index.mjs";

// This entrypoint exists only for local integration tests. It supplies a
// deterministic Access identity so the actual AMPHETAMIN Worker handler can
// be exercised without deploying or weakening the production Access policy.
export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, {
      ...ctx,
      access: {
        async getIdentity() {
          return {
            id: "local-integration-owner",
            email: "local-integration@example.invalid"
          };
        }
      }
    });
  }
};
