# AMPHETAMIN MCP Edge

**Status:** Initial production edge implementation; compute operations remain disabled.

This Worker is a stateless Streamable HTTP MCP endpoint at `POST /mcp`. It requires Cloudflare Access authentication at the Worker boundary and independently rejects requests without an Access identity in `ctx.access`.

## Current tool surface

- `group.health` — read-only health probe through the private `GROUP` Service Binding.

No job creation, cancellation, execution, shell, dynamic URL, or arbitrary tool invocation is exposed. GROUP's compute dispatch remains disabled.

## Security and deployment

- Worker-level Cloudflare Access policy is required for every public hostname.
- `workers.dev` is enabled only after the Access application is created and verified; Preview URLs stay disabled.
- GROUP is called only through the `GROUP` Service Binding. GROUP's own `workers.dev` and Preview URLs remain disabled.
- Tenant, project, actor and scopes are not accepted from MCP tool arguments. A future compute tool requires a verified Access identity-to-membership mapping and the GROUP principal contract.
- No shared `API_TOKEN` is used.
- Request and response sizes are bounded; no request bodies or identity details are written to logs.

## Runtime compatibility

The PLUGINS Tool/Skill Runtime remains Python in-process. This Worker is not yet an adapter to those cores. Compute operations must remain absent until a separately authenticated runtime bridge or parity-verified TypeScript port passes the required tests. The health probe is not proof of Tool/Skill Runtime integration.

## Local tests

Run from this directory:

```sh
npm test
```

## Production prerequisites

1. Create the Cloudflare Access organization and a Worker-level allow policy for the intended owner identity.
2. Deploy with the GROUP Service Binding.
3. Confirm the Access policy protects production and preview URLs before enabling the public Worker hostname.
4. Verify MCP initialize, tools/list, and group.health through the Access-protected endpoint.
5. Keep compute operations disabled until identity membership, Tool/Skill Runtime compatibility, durable approvals/idempotency/audit and GROUP end-to-end tests are complete.

See the [Cloud Wiki AMPHETAMIN architecture](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md).
