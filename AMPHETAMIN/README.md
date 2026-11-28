# AMPHETAMIN MCP Edge

**Status:** Live Access-protected MCP edge deployed; only the read-only GROUP health tool is exposed. Compute operations remain disabled.

This Worker is a stateless Streamable HTTP MCP endpoint at `POST /mcp`. It requires Cloudflare Access authentication at the Worker boundary and independently rejects requests without an Access identity in `ctx.access`.

## Current tool surface

- `group.health` — read-only health probe through the private `GROUP` Service Binding.

No job creation, cancellation, execution, shell, dynamic URL, or arbitrary tool invocation is exposed. GROUP's compute dispatch remains disabled.

## Security and deployment

- A hostname-based Cloudflare Access application protects `symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev` with an exact allow policy for the linked account owner.
- Cloudflare Managed OAuth is enabled on the Access application, with Dynamic Client Registration enabled. MCP clients authenticate through the standard Access-managed OAuth authorization-code flow; the Worker does not store or issue OAuth client secrets.
- The `workers.dev` hostname is enabled only behind that Access application; Preview URLs are disabled.
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

## Production deployment state

- Cloudflare Access organization and exact-email allow policy are configured.
- Worker is deployed with the private `GROUP` Service Binding.
- `workers.dev` is enabled and protected by Access; preview URLs remain disabled.
- Live Worker settings confirm the `GROUP` binding.
- A full authenticated MCP client handshake and live `group.health` result have not yet been observed from an external client.

## Remaining production gates

1. Verify MCP initialize, tools/list, and group.health through an authenticated external MCP client.
2. Add server-side identity-to-tenant/project membership mapping and enforce scopes before exposing job operations.
3. Resolve the Python Tool/Skill Runtime compatibility boundary with a separately authenticated runtime service or a parity-verified TypeScript port.
4. Implement durable approvals, idempotency, audit, timeout/unknown-outcome handling and reconciliation.
5. Keep compute operations disabled until tenant-isolation negatives and full GROUP end-to-end tests pass.

See the [Cloud Wiki AMPHETAMIN architecture](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md).
