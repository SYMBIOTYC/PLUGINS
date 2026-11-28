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