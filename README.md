# PLUGINS

Shared contracts and runtime core for SYMBIOTYC plugin and tool invocation routing.

## Contracts

- [Plugin Event Contract v1](docs/plugin-event-contract-v1.md)
- [Plugin Event JSON Schema](contracts/plugin-event-v1.schema.json)
- [Tool Invocation Runtime v1](docs/tool-invocation-runtime-v1.md)
- [Tool Invocation Request JSON Schema](contracts/tool-invocation-request-v1.schema.json)

## Runtime core

- [In-process typed invocation runtime](runtime/tool_runtime.py)
- [Runtime security and idempotency tests](tests/test_tool_runtime.py)

## Private backend access

- [Read-only preflight setup](docs/private-backend-read-preflight.md)

## Operational boundary

The Tool Invocation Runtime is currently an in-process reference core, not a deployed HTTP endpoint. It requires a trusted host to authenticate callers, supply tenant/actor/scopes, provide durable idempotency and audit services, verify approvals, and register deployment-specific adapters. Catalog discovery does not authorize invocation. Production dispatch remains disabled.
