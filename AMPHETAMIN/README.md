# AMPHETAMIN MCP Edge

**Status:** Existing Cloudflare Access-protected MCP Worker; compute tool source is being extended in this branch. Production compute activation remains gated by tenant policy, quotas, and Scheduler/Dispatcher readiness.

The live Worker name is `symbiotyc-amphetamin-mcp`. The established MCP hostname remains enabled behind the existing Cloudflare Access application. Preview URLs remain disabled. This branch extends the current `src/index.mjs` host and does not introduce a second Worker.

## Authentication and trust

Cloudflare Managed OAuth is enabled on the Access application, with Dynamic Client Registration enabled. MCP clients authenticate through the standard Access-managed OAuth authorization-code flow; the Worker does not store or issue OAuth client secrets.

Every request to the public hostname remains protected by the existing Access application and exact owner allow policy. The Worker independently calls `ctx.access.getIdentity()`; it fails closed when there is no authenticated identity.

The Access application currently has one allowed owner identity. The Worker maps that identity to the configured SYMBIOTYC tenant/project:
- tenant: `symbiotyc`
- project: `compute`
- actor: `access:<SHA-256 of normalized Access identity>`

The raw Access email is never forwarded to GROUP or written to logs/audit by AMPHETAMIN. Scopes are assigned server-side only: `compute:jobs:read`, `compute:jobs:write`, and `compute:jobs:cancel`. MCP tool arguments cannot supply or override tenant, project, actor, or scopes.

This is a single-owner, single-project policy mapping, not a general multi-user IAM implementation. If the Access allow policy is broadened, identity-to-membership mapping and per-user/project authorization must be implemented and tested before enabling additional identities.

## Private GROUP boundary

AMPHETAMIN calls only through the `GROUP` Cloudflare Service Binding to `symbiotyc-group-control-plane`. GROUP has no public workers.dev or preview ingress. The caller principal is a server-generated assertion trusted only across this private binding; it is not a cryptographic credential and must never be accepted through a public route.

No shared `API_TOKEN` is used between Assistant, AMPHETAMIN, and GROUP. No secret is stored in this repository.

## MCP tool surface

The existing MCP `2025-03-26` initialize/tool protocol is preserved. The current source exposes:

- `group.health` — read-only GROUP health probe.
- `compute_capabilities` — read tenant/project quota, enabled operation policies, and actual component readiness.
- `compute_submit_job` — submit a strict, bounded JobIntent only when GROUP says the tenant/project quota and operation policy permit it.
- `compute_get_job` — tenant/project-scoped Job read.
- `compute_cancel_job` — tenant/project-scoped cancellation request.

## Lifecycle and safety semantics

The caller's stable idempotency key is forwarded unchanged. A timeout after Job submission returns `JOB_ACCEPTANCE_UNKNOWN` with that same key and no automatic POST retry. A `QUEUED` response means durable acceptance only; it does not mean execution started or completed.

The current GROUP database has no seeded tenant quota or enabled operation policy, so `compute_submit_job` remains closed by default. GROUP reports `dispatch_enabled=false`. Scheduler, Dispatcher, Worker lifecycle/heartbeat, result validation, and artifact pipeline remain unimplemented.

## Runtime compatibility

The PLUGINS Tool/Skill Runtime remains Python in-process. The Cloudflare Worker does not import those modules or claim parity. Its compute tools currently call GROUP's Job API. A separately authenticated runtime bridge or a parity-tested TypeScript runtime adapter is still required before claiming Tool/Skill Runtime execution integration.

## Tests and release

Run from the repository root with Node.js 22:

```sh
node --test AMPHETAMIN/tests/*.test.mjs
```

Production upgrade must preserve the live Access application, exact current allow policy, `workers.dev=true`, `preview_urls=false`, and GROUP Service Binding. Only the Worker source and non-secret server-side tenant/project vars are changed.
