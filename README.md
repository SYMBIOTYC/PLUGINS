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

The [`AMPHETAMIN/`](AMPHETAMIN/) directory is currently a placeholder containing only a blank Readme; it is not an MCP server or host. The runtime modules below are in-process cores and require a separately implemented authenticated host. See the [AMPHETAMIN source audit and integration gates](docs/amphetamin-host-source-audit.md).

## Runtime core

- [In-process typed Tool invocation runtime](runtime/tool_runtime.py)
- [Sequential Skill orchestration runtime](runtime/skill_runtime.py)
- [Tool runtime tests](tests/test_tool_runtime.py)
- [Skill runtime tests](tests/test_skill_runtime.py)

## Private backend access

- [Read-only preflight setup](docs/private-backend-read-preflight.md)

## Operational boundary

Tool and Skill runtimes are in-process reference cores, not deployed HTTP endpoints. The host must authenticate callers and supply tenant/actor/scopes, durable idempotency and audit services, approval verification, and deployment-specific adapters. Skill definitions are trusted server-side mappings; they cannot widen Tool scopes or execute arbitrary catalog text. All current awesome-selfhosted candidates remain discovery-only; no production dispatch is enabled.
