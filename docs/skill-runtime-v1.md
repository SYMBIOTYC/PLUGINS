# Skill Runtime v1

**Status:** In-process sequential orchestration core implemented; no network endpoint or production deployment is enabled.  
**Code:** [`runtime/skill_runtime.py`](../runtime/skill_runtime.py)  
**Request schema:** [`contracts/skill-run-request-v1.schema.json`](../contracts/skill-run-request-v1.schema.json)  
**Tests:** [`tests/test_skill_runtime.py`](../tests/test_skill_runtime.py)

## Trust boundary

A Skill is a reviewed, versioned procedure that composes verified Tool invocations. It is not executable catalog text, a prompt, a shell script, or a source of authority. Skill definitions are trusted server-side configuration containing JSON Schemas, ordered steps, input mappings and output mappings. They are never loaded dynamically from the awesome-selfhosted catalog.

The caller supplies only the Skill ID, run ID, idempotency key, typed input and opaque approval IDs keyed by step. Tenant, actor and scopes come from the authenticated host principal. Caller-supplied tenant IDs, scopes, adapter endpoints and credentials are rejected by the strict request schema.

## Run lifecycle

1. Validate the Skill Run v1 request and the Skill input schema.
2. Require the Skill registry state to be `verified`.
3. Preflight every step before executing the first one. Each step must be declared by the Skill's Tool/Invocation requirements, and every referenced Tool and Invocation must be `verified`.
4. Resolve each step's typed input mapping from the caller input or prior step results.
5. Call the Tool Runtime with the original authenticated principal. The Skill Runtime never adds scopes or substitutes tenant identity.
6. The Tool Runtime independently enforces operation schemas, required scopes, approvals for state-changing calls, per-step idempotency and audit.
7. Validate the mapped Skill output against the Skill output schema.
8. Persist the result under the tenant-scoped Skill idempotency key and emit metadata-only audit events.

Steps run sequentially. Parallel execution, arbitrary branching, dynamic code, and automatic compensation are intentionally outside v1.

## Mapping format

A step declares:
- stable step ID;
- Tool ID and Invocation ID;
- a mapping from each target input property to a source path.

Source paths are limited to:
- `input.<property>` — the validated Skill input;
- `steps.<step_id>.result.<property>` — a result from an earlier Tool step.

The final output mapping uses the same restricted path resolver. Missing paths fail closed. No expression evaluator, template language, arbitrary Python, shell, URL fetch, or prompt execution is supported.

A step can receive an approval ID through the request's `approvals` object. The Tool Runtime verifies that approval against the exact operation and canonical input hash. A Skill cannot convert a read operation into a write or widen the operation's scopes.

## Idempotency and partial outcomes

The Skill run has a tenant-scoped idempotency key and canonical request hash. Completed runs replay the stored result without re-running steps. Each Tool step also receives a deterministic idempotency key derived from the Skill run ID and step ID.

If a step was attempted and the overall Skill fails, the Skill run is marked `unknown`; subsequent retries are blocked until the operator reconciles step receipts and external outcomes. This prevents an automatic retry from repeating a prior side effect. A failure before any step is attempted is marked terminal `failed`.

The provided in-memory ledger is for tests/development only. Production must use durable atomic storage for both Skill runs and Tool invocations, with receipts and reconciliation support.

## Current activation state

The five catalog Skills remain `proposed`. They cannot run. The Skill Runtime tests use a synthetic, verified test Skill and synthetic Tool adapter; this is test evidence for the orchestration engine, not proof that any upstream candidate is deployed or callable.

## Production acceptance gates

Before production use:
- register each Skill definition and its input/output schemas in trusted deployment configuration;
- review the complete data-flow and classification for every step;
- verify every Tool and Invocation against a pinned deployment/adapter version;
- provide durable idempotency, audit and step receipts;
- bind approvals to the exact operation and input hash;
- define bounded step deadlines, concurrency, quotas and output sizes;
- add reconciliation and compensation plans for partial multi-step workflows;
- test tenant isolation, missing scopes, invalid mappings, stale approvals, concurrent duplicate runs, mid-workflow failure and audit outages;
- expose the runtime only behind authenticated host middleware.

No current catalog Skill is marked verified and no production execution endpoint is enabled.
