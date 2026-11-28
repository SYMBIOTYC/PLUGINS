# AMPHETAMIN MCP authentication — live configuration

**Status:** Deployed and verified at the Cloudflare configuration level on 2026-11-28.  
**Worker:** `symbiotyc-amphetamin-mcp`  
**Authentication boundary:** Cloudflare Access Managed OAuth.  
**Custom Workers OAuth Provider:** Not used by the live deployment.

## Live Access application

- Application: `SYMBIOTYC AMPHETAMIN MCP`
- Type: `self_hosted`
- Hostname: `symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev`
- Session duration: `12h`
- OAuth: enabled
- Dynamic Client Registration: enabled
- Access policy: one `allow` rule for the account owner email; no broad public allow rule.
- Worker identity API: `ctx.access.getIdentity()`

The Worker rejects requests without a verified Access identity. The identity is converted to a stable SHA-256 actor pseudonym. Tenant ID is read from the trusted Worker variable `COMPUTE_TENANT_ID=symbiotyc`; MCP tool arguments cannot override tenant, actor, or scopes. The current release grants only `compute:read`.

## Production bindings

- `GROUP`: private Service Binding to `symbiotyc-group-control-plane`.
- `RUNTIME_DB`: existing EU GROUP D1 database, ID `633d7c14-d335-426c-be7e-2168a43171bc`.
- `COMPUTE_TENANT_ID`: `symbiotyc`.
- `COMPUTE_PROJECT_ID`: `compute`.

The active Worker version is `f79793c3-0c0c-48e6-8d26-5990fbbf06a3`; deployment `f669432e-18a6-41c9-9b7c-9414540532d8` serves 100% traffic. The workers.dev hostname remains enabled and preview URLs remain disabled.

## Retired bootstrap design

The earlier proposed design using a custom Cloudflare Workers OAuth Provider, a separate Access-for-SaaS OIDC client, and an `OAUTH_KV` namespace was not implemented. Cloudflare Access Managed OAuth already protects the live Worker and supplies verified identity through the Worker runtime context.

The namespace `symbiotyc-amphetamin-oauth-eu` (EU jurisdiction) was created during the earlier bootstrap exploration, but it is not bound to the Worker and is not used by this authentication design. It must not be mistaken for active OAuth storage.

## Remaining verification

Cloudflare configuration read-back confirms the app, owner-only policy, OAuth/DCR, Worker binding, and active deployment. A complete external authenticated MCP initialize/tools/list and a real `group.health` call have not yet been observed from this session. The D1 runtime tables remain empty until the first authorized tool invocation.

## References

- https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/
