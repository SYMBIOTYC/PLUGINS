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

This is a parity adapter implemented in TypeScript for the Cloudflare Worker. The original Python Tool/Skill Runtime remains authoritative in the PLUGINS root and is not imported by this Worker. The adapter is deliberately limited to the verified read-only health operation at this stage.

## Tool availability

- `group.health` — enabled through Skill Runtime and Tool Runtime.
- Compute Job submission, capability reads, Job reads, and cancellation are temporarily withheld from this runtime-parity release. They must be reintroduced only after equivalent verified Tool/Skill definitions, scope checks, approval handling for state changes, and parity tests exist.

This staged reduction is intentional: no operation may bypass the runtime boundary merely to preserve a previous MCP tool listing.

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
