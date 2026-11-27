# Tool Invocation Runtime v1

**Status:** In-process reference runtime implemented; no network endpoint or production deployment is enabled.  
**Code:** [`runtime/tool_runtime.py`](../runtime/tool_runtime.py)  
**Request schema:** [`contracts/tool-invocation-request-v1.schema.json`](../contracts/tool-invocation-request-v1.schema.json)  
**Tests:** [`tests/test_tool_runtime.py`](../tests/test_tool_runtime.py)

## Boundary and trust model

The runtime is an in-process execution core. It is not an HTTP server, authentication provider, secret manager, adapter discovery mechanism, or production idempotency database. A host must authenticate the caller and construct the trusted principal before calling `ToolRuntime.invoke()`.

The caller request contains only:
- schema version and request ID;
- tool and invocation IDs;
- idempotency key;
- typed input;
- optional opaque approval ID.

The caller cannot supply tenant identity, actor identity, scopes, adapter URL, credentials, network destinations, or approval claims. Tenant, actor, and scopes come from the trusted host principal. Approval IDs are independently verified by the host's approval verifier against the exact tenant, actor, tool, invocation, side-effect class, and canonical request hash.

The registry and handler map are trusted server-side configuration. Never derive a handler, endpoint, shell command, URL, or secret from catalog metadata or caller input. Catalog records remain untrusted discovery data.

## Invocation flow

1. Validate the request against the strict JSON Schema; reject unknown properties.
2. Resolve the tool and operation by stable IDs in the server-side registry.
3. Require both tool and invocation lifecycle states to be `verified`.
4. Validate typed input against the operation's JSON Schema.
5. Compare server-declared required scopes with the authenticated principal.
6. For `write`, `admin`, and `destructive` operations, verify an approval bound to the exact canonical request hash.
7. Emit metadata-only audit and atomically claim the tenant-scoped idempotency key.
8. Resolve a statically registered adapter handler; invoke only that handler.
9. Persist a JSON-safe result for replay and emit a terminal audit event.

## Idempotency and unknown outcomes

The idempotency key is scoped by tenant. The canonical request hash includes tenant, actor, tool, operation, and normalized input. Reusing a key with a different hash returns `IDEMPOTENCY_KEY_REUSED`. Concurrent duplicate requests return `INVOCATION_IN_PROGRESS`. A completed request replays its stored result without repeating the handler.

An adapter exception or non-JSON result is treated as `OUTCOME_UNKNOWN`. The key is quarantined and subsequent retries are blocked until a reconciliation process establishes the actual external outcome. A timeout is not evidence that a side effect did not happen.

The included `InMemoryIdempotencyStore` is thread-safe but process-local and volatile. It is for tests/development only. Production must inject a durable store with an atomic unique claim (e.g. a database unique constraint or a single-writer Durable Object) and retention longer than every retry/replay path.

## Adapter and side-effect rules

Adapters are registered by trusted application code under `(tool_id, invocation_id)`. There is no generic URL fetcher, arbitrary shell adapter, automatic installation, or catalog-to-handler binding. A host adapter must independently enforce destination allowlists, TLS verification, credential isolation, timeouts, response-size limits, and tenant isolation.

Allowed side-effect classes:
- `read`: no state change;
- `compute`: bounded inference/compute; enforce host-level quotas;
- `write`: state change; explicit approval required;
- `admin`: privileged state change; explicit approval required;
- `destructive`: irreversible or destructive state change; explicit approval and a separately tested compensation/reconciliation plan required.

The runtime emits metadata-only audit events: no raw input, output, secrets, or artifact bytes are included. Production must supply a durable audit sink and fail closed if it cannot record the pre-invocation event.

## Registry lifecycle

Only `verified` tools and invocations are callable. `discovered`, `review_required`, `approved`, `configured`, `suspended`, and `retired` states are not callable. A `configured` endpoint is not proof of successful authenticated positive/negative tests. Verification must be bound to the exact deployment version, adapter version, scopes, and test evidence.

The initial awesome-selfhosted candidates remain `discovered`; their operations remain `contract_only`. They cannot be called through this runtime.

## Production acceptance gates

Before exposing a network endpoint or enabling production calls:
- replace the in-memory ledger with durable atomic idempotency storage;
- provide a durable audit sink and immutable run receipts;
- implement authenticated tenant/actor resolution and scope issuance;
- implement an approval service that binds approvals to canonical request hashes;
- provide deployment-specific adapter allowlists and secret-manager bindings;
- enforce rate limits, concurrency limits, deadlines, payload/response limits and circuit breakers;
- implement reconciliation for unknown outcomes and a reviewed retry policy;
- test cross-tenant denial, invalid scopes, schema rejection, replay, concurrent duplicate, payload mismatch, adapter timeout, malformed result, approval replay, and audit-store outage;
- deploy only to a non-production environment first and collect operational evidence.

No production dispatch, catalog-triggered installation, or public invocation endpoint is enabled by this change.
