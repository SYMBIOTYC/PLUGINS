

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


### Verified local end-to-end result — 2026-11-28

The local multi-Worker integration gate passed in [GitHub Actions run #46133940180](https://github.com/SYMBIOTYC/PLUGINS/actions/runs/46133940180), commit `b73bc1c2bb15a2ad8b6de12a7c3dbf0bce944040`.

The run compiled the pinned GROUP C policy to WASM, passed the AMPHETAMIN unit/contract suite, applied both synthetic local D1 migration sets, and executed the real MCP `tools/call` request. Wrangler's logs show the GROUP Service Binding transitioning to `[connected]`; the caller then returned HTTP 200 for `POST /mcp`. The integration assertion verified a non-error MCP result, GROUP decision fields emitted by the WASM evaluator, and the initial activation-state snapshot read from local D1. The job concluded successfully.

This closes the local integration gate only. It does not prove live Cloudflare service-to-service connectivity, persistent staging behavior, production Access policy, production D1 correctness, or deployment readiness. The next gate is a separately isolated staging verification plan and security review; no staging resources or deployment are created by this result.


## Staging configuration preflight

The repository includes a fail-closed, read-only staging configuration validator:

```sh
node scripts/staging-preflight.mjs --staging wrangler.staging.toml --production wrangler.toml
```

The validator compares the staging config with the production config and rejects reuse of the Worker name, GROUP Service Binding target, D1 database ID/name, or tenant/project identifiers. It also requires `workers_dev = false` and `preview_urls = false` for staging. The command does not create resources, apply migrations, change bindings, or deploy.

The current production config is used only as a comparison baseline. Do not create a staging config by copying production IDs. A future staging config must reference separately provisioned staging resources.

**Important boundary:** a passing local configuration check does not verify Cloudflare Access. The report always sets `access_policy_verified: false` and identifies external Access application, hostname, and policy verification as a separate gate. Do not deploy staging until that external gate is independently confirmed and approved.
