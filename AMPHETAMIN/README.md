

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

The repository includes a fail-closed, read-only staging configuration validator. Run it from the `AMPHETAMIN` directory after checking out both repositories side by side:

```sh
npm run preflight:staging
```

Optional flags override the four inputs: `--staging`, `--production`, `--group-staging`, and `--group-production`.

The validator compares both staging Workers with their production counterparts. It rejects reuse of either Worker name, a production GROUP Service Binding target, a production D1 ID/name, or production tenant/project identifiers. It requires AMPHETAMIN and GROUP to share one dedicated staging D1 database, and requires the GROUP Worker to have `workers_dev = false`, `preview_urls = false`, and no routes or custom-domain ingress. The command does not create resources, apply migrations, change bindings, or deploy.

The current production config is used only as a comparison baseline. Do not create a staging config by copying production IDs. A future staging config must reference separately provisioned staging resources.

**Important boundary:** a passing local configuration check does not verify Cloudflare Access. The report always sets `access_policy_verified: false` and identifies external Access application, hostname, and policy verification as a separate gate. Do not deploy staging until that external gate is independently confirmed and approved.


## Staging provisioning manifest

The proposed resource topology and approval gates are defined in:
- `config/staging-provisioning-manifest.template.json`
- `config/staging-provisioning-manifest.schema.json`

The template proposes these logical names (not yet provisioned or confirmed unique):
- AMPHETAMIN Worker: `symbiotyc-amphetamin-mcp-staging`
- GROUP Worker: `symbiotyc-group-control-plane-staging`
- Shared D1: `symbiotyc-group-compute-state-staging`

The manifest requires AMPHETAMIN's `GROUP` Service Binding to target the staging GROUP Worker and both `RUNTIME_DB` and `DB` bindings to reference the same dedicated staging D1. GROUP remains Service-Binding-only, with workers.dev, Preview URLs, routes, and custom domains disabled. AMPHETAMIN is expected to be reached only through a hostname protected by a separately verified Cloudflare Access application and explicit allow policy.

Unknown resource IDs, hostname, Access application/policy IDs, tenant/project values, and identity mapping remain null or undecided. The identity model must be explicitly decided before provisioning. Secret references are intentionally empty: the inspected Worker entrypoints declare no secret bindings, and the full runtime dependency graph still requires an audit. Never place credential values in this manifest.

All authorization and deployment gates default to false. This is a planning artifact only; it does not provision resources, configure Access, apply migrations, or deploy.


The manifest also pins the reviewed GROUP migration Git blob IDs:
- `0001_compute_core.sql` — `27ce7d91d81ffd26cf16012b7536d64b1bad6006`
- `0002_runtime_ledger.sql` — `805f712000e2583fe789ab0268b88ae0e606a077`
- `0003_compute_approvals.sql` — `913166ab0cc4ef1c200ff9bd50ee4965f51739ea`
- `0004_amphetamin_activation_state.sql` — `a6274650e9e8bd7b2472e52739beb9a85b59f6c5`

Before provisioning or migration, re-read the source files at the pinned GROUP commit and recompute their Git blob IDs. Do not apply migrations merely because the manifest contains expected hashes.


### Read-only staging manifest validation

After staging Wrangler files have been created through an explicitly approved process, run:

```sh
npm run validate:staging-manifest
```

The validator compares the staging AMPHETAMIN and GROUP Worker names, the AMPHETAMIN GROUP Service Binding target, and both D1 bindings against `config/staging-provisioning-manifest.template.json`. It also recomputes Git blob object IDs for each pinned GROUP migration under `../GROUP/migrations` and fails closed on missing files, unsafe paths, or hash mismatches.

This command is read-only. It never applies migrations, creates resources, changes Access, or deploys. It always reports Access policy verification and provisioning/deployment authorization as false; those gates require separate external evidence and explicit approval. The default command will fail while staging Wrangler files or the GROUP checkout are unavailable, which is intentional.
