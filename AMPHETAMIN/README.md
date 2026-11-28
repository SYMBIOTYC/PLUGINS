

## Local multi-Worker WASM integration — CI

The dedicated workflow `.github/workflows/amphetamin-local-multi-worker.yml` exercises the complete local request path:

`MCP JSON-RPC → AMPHETAMIN Worker → Wrangler Service Binding → GROUP Worker → compiled C/WASM evaluator → local D1`.

It checks out the GROUP implementation at the pinned PR #14 head, compiles `build/amphetamin_policy.wasm`, applies GROUP migrations to two separate local D1 databases, starts GROUP and AMPHETAMIN in separate local Wrangler sessions, waits for both sessions to become ready, and verifies the Service Binding is connected, and sends a real MCP `tools/call` request through the binding. The test-only AMPHETAMIN entrypoint injects a deterministic Access identity; the production entrypoint and Access policy are not modified.

Safety properties:
- Wrangler is always started with `--local`; no `--remote` mode or remote binding is configured.
- Both test D1 databases use synthetic UUIDs, not production database IDs.
- The test fixture is not referenced by the production Worker configuration and is never deployed.
- The GROUP checkout is pinned to commit `5e56635c340a1e5dff871fe8e148c00ce960328a`; update this pin only after reviewing a newer GROUP PR #14 head.
- The integration test requires HTTP 200, a non-error MCP tool result, the full decision shape returned by the compiled WASM evaluator, and a fresh durable activation-state snapshot.

Cloudflare documents local Service Binding discovery between separate Wrangler dev sessions. The first CI attempt used multi-config mode but Wrangler reported the AMPHETAMIN → GROUP binding as `[not connected]`; the MCP tool correctly failed closed with `OUTCOME_UNKNOWN`. The harness now starts the target GROUP session first and then the AMPHETAMIN caller in a separate Wrangler session, matching Cloudflare's documented local-development procedure.
