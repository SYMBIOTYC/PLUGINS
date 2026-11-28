# AMPHETAMIN MCP host source audit

**Status:** Source not present in the supplied repository paths; integration is blocked pending the actual host source or an explicit request to bootstrap a new host.  
**Reviewed:** 2026-11-28

## Repositories and exact findings

### Public runtime repository

[SYMBIOTYC/PLUGINS](https://github.com/SYMBIOTYC/PLUGINS/tree/main/AMPHETAMIN) is the shared contract and runtime-core repository.

At the audited `main` revision:

- `AMPHETAMIN/` contained only `Readme`, a one-byte blank file.
- The directory had no MCP server entrypoint, transport, server manifest, authentication middleware, runtime configuration, adapter, or tests.
- The repository root documents `runtime/tool_runtime.py` and `runtime/skill_runtime.py` as in-process reference cores, not a deployed HTTP endpoint.
- The Tool Runtime explicitly requires the host to authenticate callers and supply a trusted principal. The host must also supply durable idempotency, audit, approval verification, and deployment-specific adapters.

This repository currently contains the execution core, not the AMPHETAMIN MCP host.

### Private plugin-source repository

[SYMBIOTYC-PLUGINS/plugins/amphetamine](https://github.com/SYMBIOTYC/SYMBIOTYC-PLUGINS/tree/main/plugins/amphetamine) contained only `Readme.md`, also a one-byte blank file.

The current private catalog records 10 owned USER-scope Plugin Creator plugins and does not contain an `amphetamine` entry. A fresh Plugin Creator inventory returned the same 10 USER-scope plugins and no AMPHETAMIN plugin. This folder is therefore a placeholder, not an imported plugin package.

It had no `plugin.json`, `.codex-plugin/plugin.json`, `mcp.json`, `.mcp.json`, skills, scripts, or runtime configuration.

## What is and is not established

| Capability | Evidence/status |
|---|---|
| Tool Runtime core | Implemented in-process in `SYMBIOTYC/PLUGINS/runtime/tool_runtime.py` |
| Skill Runtime core | Implemented in-process in `SYMBIOTYC/PLUGINS/runtime/skill_runtime.py` |
| AMPHETAMIN MCP server/host | Not present in either supplied path |
| External MCP client authentication | No host implementation found |
| Trusted tenant/project/actor/scope derivation | Contract only; no AMPHETAMIN implementation |
| GROUP Service Binding consumer | Not configured or deployed |
| GROUP API/D1 deployment | Not deployed |
| Production dispatch | Disabled |

## Required integration sequence

1. Obtain/import the actual AMPHETAMIN host source or explicitly bootstrap a new MCP host in the designated directory.
2. Identify its MCP transport and external authentication/session middleware. Never infer tenant, project, actor, or scopes from tool arguments.
3. Build a trusted principal from the authenticated session and server-side membership/authorization data.
4. Invoke the PLUGINS Tool/Skill Runtime with trusted server-side registry and handler mappings. Do not turn catalog metadata into executable handlers.
5. Provide durable idempotency, audit, approval verification, reconciliation, rate limits, deadlines, and response-size limits before production calls.
6. Add a private Cloudflare Service Binding from AMPHETAMIN to GROUP. GROUP must have no public ingress or unprotected deployment URL. Do not restore a shared `API_TOKEN`.
7. Add contract, authentication, tenant-isolation, idempotency, approval, timeout/unknown-outcome, and end-to-end tests.
8. Deploy only after the source, authentication, bindings, and negative tests are verified. Keep dispatch disabled until then.

## Security boundary

The principal assertion in the GROUP contract is trusted only over the private Service Binding from the single approved AMPHETAMIN Worker. It is not a cryptographic credential and must never be accepted over a public route. The external MCP client must be authenticated by AMPHETAMIN before a principal is created.

No Worker, secret, route, D1 database, or production deployment was changed during this source audit.


## Bootstrap authorization and runtime compatibility gate

On 2026-11-28 the user authorized bootstrapping a new AMPHETAMIN MCP host in this reserved directory and requested that the decision be recorded in the Cloud Wiki. This is authorization for source development and verification, not production deployment, provisioning, public ingress, or changes to live Workers.

The existing Tool and Skill Runtime cores are Python in-process modules. A TypeScript Cloudflare Worker cannot import them directly. Conversely, an ordinary external Python process cannot directly use a Cloudflare Worker Service Binding to GROUP. The host/runtime placement is therefore a blocking architecture decision, not an implementation detail.

Before exposing tools, compare and test these options:

1. Python MCP host with the existing Python runtime embedded, plus a verified private integration path to GROUP.
2. Cloudflare Worker MCP edge with a separately authenticated Python runtime service and a private Service Binding to GROUP.
3. A TypeScript port of Tool/Skill Runtime with behavioral parity tests before replacing or duplicating the Python implementation.

The compatibility spike must prove SDK/runtime support, authentication and principal derivation, private GROUP reachability, durable idempotency, approval verification, metadata-only audit, timeout/unknown-outcome handling, and tenant isolation. Do not enable a tool that invokes GROUP until the selected topology passes integration tests. See the [Cloud Wiki architecture decision and gates](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-MCP.md).


## Superseding production verification — 2026-11-28

This audit captured an earlier placeholder-only state and is superseded by the live deployment verified on 2026-11-28.

- The live Cloudflare Worker is `symbiotyc-amphetamin-mcp`, with an owner-only Cloudflare Access application and OAuth/Dynamic Client Registration enabled.
- The deployed source is maintained in this repository under `AMPHETAMIN/` and was merged in [PR #16](https://github.com/SYMBIOTYC/PLUGINS/pull/16).
- The deployed Worker routes only read-only `group.health` through the TypeScript Skill Runtime → Tool Runtime adapter, D1-backed idempotency/audit, and the private GROUP Service Binding.
- The four prior compute tools are withheld in this deployment. They require equivalent Tool/Skill definitions, scopes, approval verification for state-changing operations, and end-to-end tests before re-exposure.
- The private Plugin Creator catalog `SYMBIOTYC-PLUGINS/plugins/amphetamine` remains a placeholder and does not represent the deployed Cloudflare MCP Worker.
- GROUP PR #9 added and applied the canonical D1 runtime ledger migration. The runtime tables and append-only triggers are present in production.

The previous OAuth bootstrap plan using a custom Workers OAuth Provider and dedicated OAUTH_KV is superseded. The live Worker relies on Cloudflare Access Managed OAuth and `ctx.access.getIdentity()`; no Access client secret is stored in the Worker source. See [AMPHETAMIN live deployment verification](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/Live-Deployment-Verification-2026-11-28.md).


## Superseding read-only compute tool verification — 2026-11-28

The live Worker was updated again after [PLUGINS PR #18](https://github.com/SYMBIOTYC/PLUGINS/pull/18). Its active Cloudflare version is `bd9f2f99-4b56-41b7-9e57-73efd98f4800` and deployment `781111b3-33f4-4817-bf41-b1b8539a037c` serves 100% traffic.

The deployed MCP tool surface is now:
- `group.health` — read-only health check;
- `compute_capabilities` — read-only capabilities and quota/policy status;
- `compute_get_job` — read-only tenant/project-scoped Job lookup.

All three execute through Skill Runtime → Tool Runtime → D1-backed idempotency/audit → private GROUP Service Binding. The GROUP principal is server-derived from the Cloudflare Access identity and the trusted tenant/project Worker variables. It contains only `compute:read` and `compute:jobs:read`; no write or cancel scope is granted. The Job ID is UUID-validated and caller-supplied tenant/project fields are rejected.

`compute_submit_job` and `compute_cancel_job` remain withheld until the durable one-time approval service is implemented. The Access policy remains owner-only. A full authenticated external MCP call remains outstanding, so the deployment is source/configuration verified but not yet end-to-end verified by an authenticated client.


## Source-level approval verifier — 2026-11-28

The AMPHETAMIN TypeScript host now contains `AMPHETAMIN/src/approval-verifier.mjs`, wired into `ToolRuntime` through a fail-closed callback.

- The verifier maps the trusted Tool invocation IDs `submit_job` and `cancel_job` to GROUP actions `job.submit` and `job.cancel` respectively. For submit, the concrete compute operation ID is derived from the validated `job_intent.operation_id` input field; for cancel, it is fixed to `job.cancel`.
- It requires a UUID approval ID, UUID request correlation ID, exact Tool/Invocation identity, `write` side-effect class, and a 64-character lowercase SHA-256 request hash.
- It consumes the approval only through the private `GROUP` Service Binding at `POST /v1/approvals/{approval_id}/consume`.
- The forwarded GROUP principal is reconstructed with exactly one scope: `compute:approvals:consume`. Caller-provided scopes are not forwarded.
- The verifier is disabled unless `GROUP_APPROVALS_LIVE=true`; production must leave this unset until the GROUP approval routes are deployed and verified.
- Tool Runtime now includes trusted `operation_id` and `request_id` in verifier claims. Approval consumption occurs after a new idempotency claim and after replay resolution, preventing a successful replay from consuming the one-time approval again.

This source change implements only the approval-consumption half of the workflow. It does not implement approval creation, expose submit/cancel tools, enable dispatch, or change the live Worker. The GROUP production Worker is still on the pre-approval version, so the consume endpoint is not yet live. PLUGINS PR #21 was merged at `8b69c756d6a5e757126b6f0f326ec4f7dde8372d`; the AMPHETAMIN host tests, edge tests, and Plugin contract CI all passed on the final PR head. Authenticated production integration remains outstanding.

## MCP transport and Access identity conformance review — 2026-11-28

The current source of record is `AMPHETAMIN/src/index.mjs` (GitHub blob SHA `cb8f2ca2d32b7d5ddfef5ff20aeb1208968983ae`). The package test command is `node --test tests/*.test.mjs`; the current request-handler tests are in `AMPHETAMIN/tests/index.test.mjs`.

The existing test suite covers missing Access identity, stateless initialize, the three read-only tools, GROUP health invocation, missing D1/tenant/GROUP bindings, unknown tools, request-size limits, notifications, and Worker export. It does not currently test Origin-header validation or MCP protocol-version header negotiation/validation.

Source-level findings:
- The handler uses `ctx.access.getIdentity()` and fails closed when no Access identity is available.
- The current source pins `PROTOCOL_VERSION = "2025-03-26"`; it does not validate the requested initialize version or the `MCP-Protocol-Version` header.
- No Origin-header validation is present in the handler.
- `GET /mcp` returns 405. This is compatible with the optional GET/SSE behavior in the 2025-11-25 transport revision.
- The current source is a legacy 2025-03-26 Streamable HTTP profile. Do not describe it as supporting the 2026-07-28 transport revision without a dedicated implementation and tests.

Release distinction: the GitHub source includes `createGroupApprovalVerifier` in `AMPHETAMIN/src/index.mjs`, while the active Cloudflare deployment does not include that source-only approval consumer. This is intentional and matches the README release gate: the verifier is merged in source but not deployed; the production Worker continues to expose only the three read-only tools.

No source code, tests, Worker deployment, Access policy, or D1 data was changed as part of this review. Any protocol hardening must follow TDD: add failing request-handler tests first, implement the minimal behavior, run `node --test tests/*.test.mjs`, and only then prepare a reviewed release. The exact protocol revision expected by the ChatGPT client must be confirmed before changing the advertised protocol version.

References:
- [MCP 2025-11-25 Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx)
- [MCP 2026-07-28 Streamable HTTP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)
- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)


## Draft PR #24 — Origin validation hardening

A draft implementation is in [PR #24](https://github.com/SYMBIOTYC/PLUGINS/pull/24), branch `security/amphetamin-origin-validation`.

Changes on the branch:
- Added a strict HTTPS Origin allowlist check before route handling and before Access identity processing. Requests without an Origin header continue to support server-to-server MCP clients; requests with an Origin must match an exact configured origin.
- The allowlist is configured through non-secret `MCP_ALLOWED_ORIGINS`, set in `AMPHETAMIN/wrangler.toml` to `https://chatgpt.com,https://chat.openai.com`.
- Invalid, non-HTTPS, path-bearing, lookalike, and unconfigured Origin values are rejected with HTTP 403.
- The same check applies to both `/mcp` and `/health`.
- Added regression cases for absent configuration, exact allowlist match, lookalike host, malformed/non-HTTPS values, and the health route.
- Added a GitHub Actions workflow using Node.js 22 and the repository's actual command: `node --test tests/*.test.mjs`.

TDD ordering: tests were committed before the implementation. However, the available GitHub connector reports no workflow runs and no commit statuses for the branch, so neither the RED run nor GREEN run has been observed. The PR remains draft and must not be merged until CI actually executes and passes.

The implementation does not add `MCP-Protocol-Version` negotiation or claim support for the 2026-07-28 protocol. The deployed server remains pinned to legacy `2025-03-26`; the 2026-07-28 revision changes the protocol model substantially (stateless request metadata, no initialize handshake, and required mirrored headers). Changing protocol versions requires a separate compatibility design and client verification.

No production Worker deployment or Access policy change was made.


### CI result update — 2026-11-28

The PR workflow has now executed successfully. GitHub Actions run [46125027544](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125027544) completed with conclusion `success`; its `node --test tests/*.test.mjs` step reports **54 tests passed, 0 failed**. The existing AMPHETAMIN MCP host tests, AMPHETAMIN MCP edge tests, and Plugin contract CI also completed successfully on the PR merge commit.

PR #24 is no longer draft and is mergeable. It remains open and unmerged; production deployment remains a separate gated operation.


## OAuth interoperability preflight — 2026-11-28

A fresh Access API read-back confirms Managed OAuth and DCR enabled on the `self_hosted` application, with the stable ChatGPT callback and callback-ID-specific callback pattern in the allowlist. The owner-only policy is unchanged. The API response omits `oauth_configuration.grant`; the Access app's separate `session_duration=12h` is not an OAuth refresh-token grant lifetime.

Cloudflare Workers Access documentation confirms that a direct Access-authenticated Worker invocation receives `ctx.access`; `ctx.access.getIdentity()` is the supported identity API and does not require application code to parse the Access JWT. The MCP handler's fallback for missing identity returns 401 with `WWW-Authenticate: Bearer`; the Access edge should challenge unauthenticated requests before Worker execution when the Access application is active.

OpenAI's current plugin authentication contract requires Protected Resource Metadata, Authorization Server Metadata with PKCE S256 support, DCR registration metadata when DCR is used, RFC 8707 `resource` propagation, and exact callback URI allowlisting. The configured callbacks match the documented stable and callback-ID-specific ChatGPT patterns. Cloudflare Managed OAuth documentation claims RFC 8707 support and discovery metadata, but the actual public discovery JSON, challenge value, PKCE advertisement, DCR endpoint, token endpoint auth methods, refresh-token behavior, and resource echo have not been retrieved. The web reader cannot access the protected well-known endpoints; no connected browser context is available. These remain hard blockers for asserting OAuth interoperability.

Fresh read-only production checks:
- Active Worker deployment/version unchanged; 100% traffic on `bd9f2f99-4b56-41b7-9e57-73efd98f4800`.
- Workers Observability query for the last 24 hours returned zero events for the AMPHETAMIN service.
- D1 row counts remain zero in `runtime_audit_events` and `runtime_idempotency`.
- No authenticated MCP request or OAuth exchange has been observed.

Next gate: capture the Access 401 challenge and both discovery documents with an RFC 8707 + PKCE S256 client, validate issuer/resource/S256/DCR/token-auth metadata, complete authorization, then run `initialize → tools/list → group.health` and correlate Worker telemetry plus D1 rows. No production changes were made.


## Live OAuth discovery result and refresh-grant configuration — 2026-11-28

The read-only GitHub Actions preflight now successfully retrieves the actual Cloudflare Access challenge and both discovery documents from production.

Observed metadata:
- Unauthenticated MCP POST returns HTTP 401.
- `WWW-Authenticate` points to `https://symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev/.well-known/cloudflare-access-protected-resource/mcp`.
- Protected Resource Metadata identifies the canonical resource as the full endpoint `https://symbiotyc-amphetamin-mcp.vladyslavchaplygin.workers.dev/mcp`.
- Authorization server issuer: `https://falling-mountain-3235.cloudflareaccess.com`.
- Authorization endpoint: `/cdn-cgi/access/oauth/authorization`.
- Token endpoint: `/cdn-cgi/access/oauth/token`.
- DCR endpoint: `/cdn-cgi/access/oauth/registration`.
- Token endpoint auth methods: `client_secret_basic`, `client_secret_post`, and `none`.
- `code_challenge_methods_supported` includes `S256`.
- `grant_types_supported` includes `authorization_code` and `refresh_token`; `response_types_supported` includes `code`.
- `scopes_supported` is absent/empty and `offline_access` is not separately advertised. The explicit `refresh_token` grant is the provider's advertised refresh capability; the probe treats it as equivalent refresh support, but does not claim a refresh token was actually issued.
- `authorization_response_iss_parameter_supported=false`. ChatGPT therefore uses the callback-ID-specific redirect path, which is covered by the existing `https://chatgpt.com/connector/oauth/*` allowlist entry.

Cloudflare Access OAuth grant configuration was updated through a read-before-write/full-object PUT/read-after-write sequence:
- `oauth_configuration.grant.access_token_lifetime=15m`
- `oauth_configuration.grant.session_duration=168h` (7 days)
- Existing outer Access application `session_duration=12h` remains unchanged.
- OAuth enabled, DCR enabled, both ChatGPT redirect allowlist entries, and the owner-only policy ID remain unchanged.

This configuration is based on Cloudflare's documented agent recommendation of a short access token and longer refresh grant. No DCR registration, authorization-code exchange, token issuance, or refresh request has yet been performed. RFC 8707 resource parameter echo is not proven until the authorization/token flow is exercised.

GitHub Actions on the latest PR head:
- OAuth discovery preflight run [46125624597](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125624597): success.
- AMPHETAMIN tests run [46125624632](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125624632): success.
- MCP host tests run [46125624624](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125624624): success.
- MCP edge tests run [46125624667](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125624667): success.
- Plugin contract CI run [46125624729](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46125624729): success.

The preflight is read-only and does not register a client, exchange tokens, or invoke tools. Production Worker version and D1 data remain unchanged. The live authenticated MCP round-trip remains unverified.


## PR #24 merged — production deployment remains separate

PR [#24](https://github.com/SYMBIOTYC/PLUGINS/pull/24) was squash-merged to `main` at `68df7246b3e1a1818990fe8142dfe593a6a34b45`. Read-back from `main` confirms the Origin guard and OAuth preflight script are present. All five CI workflows on the final PR head passed, including the live OAuth discovery probe.

A fresh post-merge Cloudflare read-back confirms the production Worker is still on deployment `781111b3-33f4-4817-bf41-b1b8539a037c`, version `bd9f2f99-4b56-41b7-9e57-73efd98f4800`, at 100% traffic. The source changes from PR #24 are merged but NOT deployed. The production Worker has not yet received the `MCP_ALLOWED_ORIGINS` variable or the new Origin guard.

Post-grant-change production checks:
- Access OAuth grant persists at `access_token_lifetime=15m`, `session_duration=168h`.
- OAuth and DCR remain enabled; callback allowlist and owner-only policy ID remain unchanged; outer Access session remains `12h`.
- Last-24-hour Worker telemetry query returned 0 AMPHETAMIN events.
- D1 row counts remain `runtime_audit_events=0`, `runtime_idempotency=0`.

Next production step is a separately reviewed Worker deployment of the merged source and allowlist variable, followed by a local RFC 8707 + PKCE S256 authorization-code test (or eligible ChatGPT Web connection) and authenticated MCP round-trip. Do not mark the server connected yet.


## Production release pipeline prepared — 2026-11-28

A read-only Cloudflare Worker settings read-back confirms that the live production bindings still include:
- `GROUP` → `symbiotyc-group-control-plane` (production);
- `RUNTIME_DB` → D1 `633d7c14-d335-426c-be7e-2168a43171bc`;
- `COMPUTE_TENANT_ID=symbiotyc` and `COMPUTE_PROJECT_ID=compute`;
- observability, invocation logs, and traces enabled.

The current deployed bindings do **not** include `MCP_ALLOWED_ORIGINS`. The merged `AMPHETAMIN/wrangler.toml` declares the exact allowlist `https://chatgpt.com,https://chat.openai.com`. A complete Wrangler deployment is required to activate that variable and the strict Origin guard; uploading only `src/index.mjs` is insufficient.

[PR #25](https://github.com/SYMBIOTYC/PLUGINS/pull/25) adds a manual-only GitHub Actions release workflow:
- explicit `workflow_dispatch` confirmation `confirm_production_deploy=yes`;
- GitHub `production` environment gate;
- full `npm test` suite;
- read-only live OAuth discovery preflight;
- Wrangler 4.169.0 dry-run;
- production deploy from the full `AMPHETAMIN/wrangler.toml`, including D1 and GROUP bindings.

No secrets are stored in source. Before the first dispatch, configure a dedicated `CLOUDFLARE_API_TOKEN` repository secret and required reviewers/deployment restrictions on the `production` environment. The release runbook is maintained in [SYMBIOTYC-CLOUD-WIKI](https://github.com/SYMBIOTYC/SYMBIOTYC-CLOUD-WIKI/blob/main/Architecture/Compute-Infrastructure/AMPHETAMIN-Production-Release-Runbook.md).

The PR is open and not merged. No production deployment, binding mutation, Access policy change, secret change, or D1 write was performed. The active production version remains `bd9f2f99-4b56-41b7-9e57-73efd98f4800` at 100%. Authenticated OAuth/MCP E2E remains unverified.
