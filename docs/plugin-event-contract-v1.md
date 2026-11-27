# Plugin Event Contract v1

**Status:** Contract draft; not yet connected to a dispatcher or production workflow.  
**Canonical schema:** [`contracts/plugin-event-v1.schema.json`](../contracts/plugin-event-v1.schema.json)

## Purpose

This is the versioned routing envelope shared by plugin producers and the public `SYMBIOTYC/PLUGINS` hub. It carries identity, provenance, an action request, opaque artifact references and requested capabilities. It is not a file-transfer format and does not authorize execution.

## Trust boundary

Every event and every field is untrusted until authenticated and validated by the receiving workflow.

- The hub must authenticate the sender independently of the event body.
- The runtime must compare `source_repository`, `plugin_id`, `action` and `requested_capabilities` against server-side allowlists. A syntactically valid value is not an authorization decision.
- The schema deliberately has no arbitrary `payload`, `token`, `secret`, `environment` or download-URL field. Unknown properties are rejected.
- `artifact_refs[].ref` is an opaque identifier, not a URL. A private reference is resolved only by an authorized private-side worker.
- Private bytes, private download URLs, credentials, customer files and private logs must never be copied into public workflow inputs, logs, caches, artifacts, commits or releases.
- `source_commit` binds the request to an immutable source revision. The receiver must verify that it belongs to the declared repository and permitted ref.
- `idempotency_key` must remain stable across retries of the same intent. The future dispatcher must claim it atomically and reject reuse with a different normalized request hash.

## Routing sequence

1. Authenticate the GitHub App or trusted service that delivered the event.
2. Validate the JSON against the schema in this repository.
3. Authorize the source repository, plugin ID, action and every requested capability against server-side policy.
4. Verify the source commit/ref relationship.
5. Atomically claim the idempotency key and persist a run-ledger record.
6. Route private work to the private execution boundary; pass only opaque references and approved metadata.
7. Return a run ID and status. Publish only explicitly public-safe result metadata.

## Example

```json
{
  "schema_version": "1.0",
  "event_id": "018f47d2-8c3a-7a41-9b10-8a11b12c13d4",
  "plugin_id": "example-plugin",
  "action": "validate",
  "source_repository": "SYMBIOTYC/example-plugin",
  "source_ref": "refs/heads/main",
  "source_commit": "0123456789abcdef0123456789abcdef01234567",
  "request_id": "118f47d2-8c3a-7a41-9b10-8a11b12c13d4",
  "idempotency_key": "example-plugin:validate:request-001",
  "actor": {
    "type": "github_app",
    "id": "symbiotyc-plugin-app"
  },
  "issued_at": "2026-11-27T19:00:00Z",
  "artifact_refs": [
    {
      "visibility": "private",
      "ref": "private-artifact:asset-001",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "requested_capabilities": [
    "plugin.validate"
  ]
}
```

The example is illustrative only; `example-plugin`, action names and capabilities are not registered production allowlist entries.

## Not implemented by this contract

Schema validation alone does not provide sender authentication, authorization, replay protection, atomic idempotency, artifact access control, a run ledger, a private worker, retries, cancellation or audit logging. Those are dispatcher/worker responsibilities and must be tested before production activation.


## Automated contract CI

The public hub validates the event schema and negative security cases through `.github/workflows/plugin-contract-ci.yml`.

- Triggers: every push to `main`, every pull request, and manual `workflow_dispatch`.
- No path filters are used, so moving a plugin file cannot suppress the contract workflow.
- Workflow permissions are read-only (`contents: read`); checkout and Python setup actions are pinned to immutable commit SHAs.
- The workflow installs the pinned `jsonschema` validator and runs the standard-library `unittest` suite.
- This CI validates the public event envelope only. It does not authenticate senders, access private repositories, dispatch private work, or publish artifacts.
