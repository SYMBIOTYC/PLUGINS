# AMPHETAMIN MCP host — OAuth bootstrap plan

**Status:** Design selected; implementation and deployment pending.  
**Target:** Cloudflare Worker symbiotyc-amphetamin-mcp; remote MCP Streamable HTTP endpoint /mcp.  
**Date:** 2026-11-28.

## Decision

Use the Cloudflare Agents SDK stateless MCP handler and Cloudflare Workers OAuth Provider, with Cloudflare Access for SaaS OIDC as the upstream identity provider. Use authorization-code flow with PKCE and explicit MCP client consent. Do not invent a static bearer-token scheme.

## Live prerequisites

The selected Cloudflare account has a Zero Trust organization and Access authentication domain, but currently has no Access applications, no external identity-provider records, no AMPHETAMIN Worker, and no OAuth KV namespace for this service. Built-in One-time PIN may be usable, but it must be verified/configured and restricted by an explicit Access policy.

## Service topology

Remote MCP client
  -> OAuth 2.1 authorization-code + PKCE
  -> AMPHETAMIN MCP Worker (/mcp, /authorize, /callback, /token, /register)
  -> verified identity + server-side membership lookup
  -> private Cloudflare Service Binding
  -> GROUP Worker
  -> GROUP D1

GROUP remains private: no workers.dev, no preview URLs, no public routes. AMPHETAMIN is the only intended caller.

## Dependencies

- agents — Cloudflare Agents SDK stateless MCP handler.
- @modelcontextprotocol/server — MCP SDK v2.
- @cloudflare/workers-oauth-provider — OAuth provider and token issuance.
- zod — input schema validation.

Bindings:
- GROUP — Service Binding to symbiotyc-group-control-plane.
- OAUTH_KV — OAuth state/client/session storage.

Cloudflare secrets only:
- ACCESS_CLIENT_ID
- ACCESS_CLIENT_SECRET
- ACCESS_TOKEN_URL
- ACCESS_AUTHORIZATION_URL
- ACCESS_JWKS_URL
- COOKIE_ENCRYPTION_KEY

Never commit these values to source, Wiki, or logs. Never ask the user to paste them into chat.

## Identity and authorization invariants

1. Validate Access ID token signature against configured JWKS.
2. Validate issuer, audience, expiry, nonce/state, and subject.
3. Bind authorization codes to client, redirect URI, requested resource, scope, and PKCE verifier.
4. Require explicit consent for each unapproved MCP client.
5. Map verified subject to tenant/project membership using server-side records.
6. Derive actor and scopes from server-side policy, never from caller arguments or identity headers.
7. Never expose raw Access tokens, refresh tokens, client secrets, or cookie keys in results/logs.
8. Call GROUP only through private Service Binding with principal assertion derived from verified context.

## Public ingress

Remote MCP clients require a reachable endpoint. The selected account currently has no custom domain zone, so the initial endpoint would use the account's workers.dev hostname and OAuth protection. Do not deploy anonymously. Cloudflare recommends custom domains or Workers routes for business-critical production services; revisit when an owned zone is available.

## Acceptance tests

- MCP initialize and tools/list over Streamable HTTP.
- OAuth discovery, dynamic client registration, PKCE, explicit consent, callback, and token exchange.
- Invalid, expired, wrong-audience, wrong-issuer, and revoked token rejection.
- State/nonce replay and redirect URI mismatch rejection.
- Unapproved MCP client cannot call tools.
- No tenant/project/actor/scope override through tool arguments.
- Missing GROUP binding fails closed.
- Private GROUP binding rejects missing/malformed principal and wrong scope.
- Idempotency replay and payload-conflict tests.
- Secrets absent from repository files, MCP results, and audit events.

## Current production state

The OAuth KV namespace exists in the EU jurisdiction, but it is not yet bound to a deployed Worker. GROUP D1 currently has no project quota or enabled operation policy rows; therefore no production Job can be accepted. Do not invent tenant/project ownership, quotas, or operation allowlists. The GROUP Worker is active on deployment version 1, but source/deployed-version parity is not verified.

## Deployment gate

Deploy only after bundle build and tests pass, OAuth KV and Access OIDC configuration are provisioned, and secrets are stored directly in Cloudflare. Enable the public MCP hostname only with OAuth enforcement in place. Do not expose placeholder tools or activate GROUP dispatch until end-to-end tests pass.

## References

- https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
- https://github.com/cloudflare/workers-oauth-provider
