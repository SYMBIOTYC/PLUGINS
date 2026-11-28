# AMPHETAMIN Production Release Runbook

## Scope

This workflow deploys the reviewed `AMPHETAMIN/` Worker from the selected GitHub ref to the existing Cloudflare production Worker `symbiotyc-amphetamin-mcp`.

It is deliberately manual. A dispatch must explicitly set `confirm_production_deploy=yes`; the job also targets the GitHub `production` environment. Configure required reviewers on that environment before enabling production use.

## Required GitHub configuration

1. Add repository Actions secret `CLOUDFLARE_API_TOKEN`. Do not store the token in this repository, workflow YAML, issue comments, or ChatGPT messages.
2. Scope the token to the intended Cloudflare account and grant only the permissions required to deploy Workers and resolve the configured D1 and Service bindings. Prefer a dedicated token over a Global API Key.
3. Configure the GitHub Environment named `production` with required reviewers and deployment branch restrictions (normally `main`).
4. Ensure the workflow run is dispatched from the reviewed `main` commit after its pull request has merged.

## Pre-deployment gates

The workflow performs, in order:

1. `npm test` from `AMPHETAMIN/`.
2. Read-only production OAuth discovery validation using `scripts/oauth-preflight.mjs`.
3. Wrangler 4.169.0 dry-run bundling using `wrangler.toml`.
4. Production deployment using the same Wrangler config.

The config explicitly declares:
- `MCP_ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com`
- `GROUP` Service Binding to `symbiotyc-group-control-plane` (production)
- `RUNTIME_DB` D1 binding to database `633d7c14-d335-426c-be7e-2168a43171bc`
- tenant and project identifiers.

Do not replace this deployment with a single-file script upload: all imported ES modules and the complete binding metadata must be included.

## Post-deployment verification

After a successful run, independently read back the Cloudflare Worker deployment and settings. Confirm the new version is at 100%, the two bindings and allowed-origin variable are present, and observability remains enabled.

Then test:
- unauthenticated MCP request returns the expected Access OAuth 401 challenge;
- allowed ChatGPT Origin is accepted after authentication and a disallowed HTTPS Origin is rejected with 403;
- authenticated `initialize` and `tools/list` work;
- read-only `group.health` succeeds while GROUP dispatch remains disabled;
- D1 audit/idempotency rows and Worker telemetry contain the expected invocation records.

A successful upload alone is not proof of an authenticated MCP round-trip. Do not describe the server as connected to ChatGPT until the OAuth authorization-code/PKCE flow, resource binding, tool calls, and telemetry/audit checks have all been verified.

## Rollback

Record the prior production deployment/version before release. If post-deployment smoke tests fail, restore the prior deployment using Cloudflare's deployment/version management API, then verify the old version is serving 100% traffic. Do not delete the failed version or audit records during rollback.
