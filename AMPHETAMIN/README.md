# AMPHETAMIN MCP Edge

**Status:** Live Cloudflare Access-protected MCP Worker. PR #18 is merged and deployed; the active Worker version is `bd9f2f99-4b56-41b7-9e57-73efd98f4800` (100% traffic).

## Live service boundary

- Worker: `symbiotyc-amphetamin-mcp`
- MCP endpoint: existing Access-protected `/mcp` hostname
- Authentication: Cloudflare Access Managed OAuth and `ctx.access.getIdentity()`
- Private compute backend: Service Binding `GROUP` → `symbiotyc-group-control-plane`
- Durable runtime ledger: `RUNTIME_DB` → the existing EU GROUP D1 database
- D1 migration: canonical `GROUP/migrations/0002_runtime_ledger.sql`, merged in GROUP PR #9 and applied to production.

## Runtime integration stage

The three exposed read-only MCP tools execute through:

`MCP request → verified Skill → verified Tool/Invocation → trusted GROUP Service Binding adapter`

The runtime layer includes strict request/schema validation, trusted server-side handlers, tenant-scoped D1 idempotency, append-only metadata-only audit, preflight validation, and unknown-outcome quarantine. A source-level GROUP approval consumer is now integrated into the Tool Runtime; it is gated by `GROUP_APPROVALS_LIVE=true`, requires an operation-bound approval ID, and uses a consume-only principal. The gate remains unset/false in production.

This is a parity adapter implemented in TypeScript for the Cloudflare Worker. The original Python Tool/Skill Runtime remains authoritative in the PLUGINS root and is not imported by this Worker. The deployed adapter currently exposes the three live verified read-only tools; PR #25 adds a fourth read-only activation-state tool on the feature branch, pending the GROUP API dependency; the approval consumer is source-integrated but is not part of the live Worker bundle.

## Tool availability

- `group.health` — enabled through Skill Runtime and Tool Runtime.
- `compute_capabilities` — enabled, read-only.
- `compute_get_job` — enabled, read-only.
- `compute_activation_state` — added on PR #25 as a read-only view of GROUP's durable activation/deployment-streak/burnout snapshot. It requires the GROUP PR #12 activation-state API and is not part of the live deployed tool surface until both changes are released.
- `compute_activation_evaluate` — added on PR #26 as a policy-only evaluation call to GROUP `POST /v1/activation/evaluate` through the existing private Service Binding. It uses a server-derived service principal scoped only to `compute:activation:evaluate`; callers provide bounded telemetry, while GROUP supplies durable activation/burnout state and cryptographic randomness. The result does not dispatch jobs or provision Workers. It depends on GROUP PR #14 and is not live until both PRs are merged and released.
- `compute_submit_job` and `compute_cancel_job` — withheld. Approval creation and write Tool/Skill definitions are not yet implemented; the live GROUP approval routes are unavailable.

This staged reduction is intentional: no operation may bypass the runtime boundary merely to preserve a previous MCP tool listing.

The policy evaluation tool is a telemetry what-if/evaluation surface, not an autonomous scaling trigger. Its caller-supplied telemetry must come from a trusted upstream controller before any future automated use; the current MCP interface does not schedule, dispatch, or provision work.

## Identity and trust

Cloudflare Access must authenticate the request before the Worker executes. The Worker maps the single owner identity to the configured `symbiotyc/compute` tenant/project. Read-only requests receive only the read scopes required by their Tool; the approval consumer independently constructs a GROUP principal containing only `compute:approvals:consume`. Actor identity is pseudonymized as `access:<SHA-256>`; raw email is not forwarded to GROUP or written to audit.

This is a single-owner, single-project mapping, not general multi-tenant IAM. The Access allow policy must remain restricted to the intended owner. MCP arguments cannot supply tenant, project, actor, or scopes.

## D1 ledger

The production EU D1 database now contains:
- `runtime_idempotency` — tenant-scoped Tool/Skill run claims and replay results;
- `runtime_audit_events` — metadata-only append-only runtime events.

Update/delete triggers protect the audit table. The migration is maintained canonically in the GROUP repository; do not create a competing migration history in this repository.

## Release and deployment

Run from repository root:

```sh
node --test AMPHETAMIN/tests/*.test.mjs
```

Before upgrading the live Worker:
1. pass the full Node test suite;
2. verify D1 ledger integration against the real schema;
3. preserve Access Managed OAuth, exact owner allow policy, `workers_dev=true`, `preview_urls=false`, GROUP Service Binding, and D1 binding;
4. deploy the reviewed bundle;
5. verify the Access-protected MCP initialize/tools/list and a real `group.health` call;
6. confirm the D1 audit row and idempotency row are recorded without secrets or raw email.

Production deployment is complete. Cloudflare read-back confirms the active version, D1 binding, private GROUP binding, owner-only Access policy, OAuth/DCR configuration, `workers.dev=true`, and `previews_enabled=false`. A full authenticated external MCP handshake and production read-only tool invocation remain outstanding; do not claim end-to-end request success until those are observed. The GROUP Worker remains on its pre-approval live version; the approval routes are not active there.


## Source approval verifier — merged, not deployed

[PLUGINS PR #21](https://github.com/SYMBIOTYC/PLUGINS/pull/21) is merged at `8b69c756d6a5e757126b6f0f326ec4f7dde8372d`. The AMPHETAMIN source now contains a fail-closed one-time GROUP approval consumer, wired into Tool Runtime. The three AMPHETAMIN MCP host/edge/contract CI workflows passed on the final PR head.

For `submit_job`, the verifier maps the invocation to GROUP action `job.submit`, while the operation ID is derived from the validated `job_intent.operation_id` field and bound into the exact Tool request hash. For `cancel_job`, the action and operation ID are both fixed to `job.cancel`. The verifier forwards only `compute:approvals:consume` through the private GROUP Service Binding.

The verifier remains disabled unless `GROUP_APPROVALS_LIVE=true`. The live GROUP Worker still runs its pre-approval version, so approval creation and consumption routes are not active in production. No submit/cancel tools are advertised, and no dispatch or production Worker update was performed.


## Cloudflare Access OAuth client callbacks — 2026-11-28

The production Access application has Managed OAuth and Dynamic Client Registration enabled. Its DCR redirect allowlist was incomplete: localhost and loopback clients were allowed, but ChatGPT's HTTPS callback URIs were not listed. The live Access application was updated and read back with these exact allowlist entries:

- `https://chatgpt.com/connector_platform_oauth_redirect` — stable ChatGPT callback.
- `https://chatgpt.com/connector/oauth/*` — callback-ID-specific ChatGPT callback path.

The existing owner-only Access allow policy, 12-hour Access session, Worker deployment, GROUP Service Binding, and D1 binding were preserved. This fixes the callback allowlist gap; it does not by itself prove DCR registration, browser authorization, MCP initialize/tools/list, or a real tool invocation. Those authenticated end-to-end checks remain outstanding.
