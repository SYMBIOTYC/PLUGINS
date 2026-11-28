# PLUGINS

Shared contracts and runtime core for SYMBIOTYC plugin, Tool and Skill invocation routing.

## Contracts

- [Plugin Event Contract v1](docs/plugin-event-contract-v1.md)
- [Plugin Event JSON Schema](contracts/plugin-event-v1.schema.json)
- [Tool Invocation Runtime v1](docs/tool-invocation-runtime-v1.md)
- [Tool Invocation Request JSON Schema](contracts/tool-invocation-request-v1.schema.json)
- [Skill Runtime v1](docs/skill-runtime-v1.md)
- [Skill Run Request JSON Schema](contracts/skill-run-request-v1.schema.json)

## AMPHETAMIN host status

The [`AMPHETAMIN/`](AMPHETAMIN/) directory now contains the source for the live Access-protected Cloudflare MCP Worker `symbiotyc-amphetamin-mcp`. PR #16 is merged and deployed. The current Worker exposes three read-only tools—`group.health`, `compute_capabilities`, and `compute_get_job`—through the TypeScript Skill Runtime → Tool Runtime adapter, D1 idempotency/audit, and private GROUP Service Binding. The GROUP approval service is merged in source and its D1 migration is applied to production, but the live GROUP Worker upgrade was blocked by Cloudflare security. The AMPHETAMIN-side approval verifier is not yet integrated; submit/cancel tools remain unadvertised. See the [AMPHETAMIN deployment and source audit](docs/amphetamin-host-source-audit.md).

## Runtime core

- [In-process typed Tool invocation runtime](runtime/tool_runtime.py)
- [Sequential Skill orchestration runtime](runtime/skill_runtime.py)
- [Tool runtime tests](tests/test_tool_runtime.py)
- [Skill runtime tests](tests/test_skill_runtime.py)

## Private backend access

- [Read-only preflight setup](docs/private-backend-read-preflight.md)

## Operational boundary

The Python Tool and Skill runtimes remain in-process reference cores. The live Cloudflare Worker uses a tested TypeScript parity adapter for the read-only `group.health` operation; it does not import Python code. The host authenticates through Cloudflare Access, derives tenant/actor/scopes server-side, and uses the shared GROUP D1 runtime ledger for idempotency and metadata-only audit. Compute writes and cancellation remain withheld pending approval verification and end-to-end parity. Skill definitions are trusted server-side mappings; they cannot widen Tool scopes or execute arbitrary catalog text. All current awesome-selfhosted candidates remain discovery-only; no production dispatch is enabled.
