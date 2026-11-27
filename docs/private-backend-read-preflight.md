# Private backend read-only access

The public hub has a manual-only preflight workflow at `.github/workflows/private-backend-read-preflight.yml`.

It is deliberately separate from the public contract CI:
- Trigger: `workflow_dispatch` only.
- Requires the operator to confirm `confirm_read_only=true`.
- Uses the protected GitHub Environment `private-backend-read`.
- Mints a short-lived GitHub App installation token scoped to repository `SYMBIOTYC-PLUGINS` with `contents: read` only.
- Checks out the private backend with `persist-credentials: false`.
- Parses the private catalog but prints no plugin names, source content, IDs or file paths.
- Does not execute private plugin code, dispatch jobs, upload artifacts or write to the private repository.

## One-time GitHub configuration required

The workflow is not runnable until the owner configures the following through GitHub's secure settings UI. Do not paste the private key or any credential into ChatGPT.

1. Create a dedicated GitHub App for read-only private-backend access.
2. Grant only repository **Contents: Read-only** (GitHub's mandatory Metadata read is implicit).
3. Install the App on `SYMBIOTYC/SYMBIOTYC-PLUGINS` only. Do not grant access to unrelated repositories.
4. In the public `SYMBIOTYC/PLUGINS` repository, create the Environment `private-backend-read`.
5. Configure required reviewers for that Environment before adding secrets.
6. Add Environment secrets:
   - `SYMBIOTYC_READ_APP_ID`
   - `SYMBIOTYC_READ_APP_PRIVATE_KEY`
7. Run the workflow manually with `confirm_read_only=true`, approve the Environment deployment, and verify the generic success result.

The workflow uses immutable action commit pins:
- `actions/create-github-app-token` v1.12.0
- `actions/checkout` v4.2.2
- `actions/setup-python` v5.6.0

## Security boundary

This workflow proves only that the public hub can obtain a short-lived read-only token and read the private catalog. It is not the production dispatcher and grants no write, Actions, deployment, or artifact permissions. Do not add `repository_dispatch`, private artifact transfer, or arbitrary code execution to this workflow.
