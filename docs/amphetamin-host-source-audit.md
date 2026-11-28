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
