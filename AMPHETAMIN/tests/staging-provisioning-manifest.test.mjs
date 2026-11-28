import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../config/staging-provisioning-manifest.template.json", import.meta.url);
const schemaUrl = new URL("../config/staging-provisioning-manifest.schema.json", import.meta.url);

test("staging provisioning manifest is explicit and non-deployable by default", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.kind, "SymbiotycStagingProvisioningManifest");
  assert.equal(manifest.metadata.environment, "staging");
  assert.equal(manifest.metadata.provisioning_authorized, false);
  assert.equal(manifest.approval.deploy_allowed, false);
  assert.equal(manifest.approval.access_policy_verified, false);
});

test("manifest fixes the isolated Worker and Service Binding topology", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.resources.workers.amphetamin.name, "symbiotyc-amphetamin-mcp-staging");
  assert.equal(manifest.resources.workers.group.name, "symbiotyc-group-control-plane-staging");
  assert.equal(manifest.resources.workers.amphetamin.bindings.GROUP.service,
    manifest.resources.workers.group.name);
  assert.equal(manifest.resources.workers.group.ingress.service_binding_only, true);
  assert.deepEqual(manifest.resources.workers.group.ingress.routes, []);
  assert.deepEqual(manifest.resources.workers.group.ingress.custom_domains, []);
});

test("manifest requires one dedicated D1 shared by both Workers and GROUP-owned migrations", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.resources.d1.name, "symbiotyc-group-compute-state-staging");
  assert.equal(manifest.resources.d1.database_id, null);
  assert.deepEqual(manifest.resources.d1.consumers.sort(), ["AMPHETAMIN.RUNTIME_DB", "GROUP.DB"]);
  assert.equal(manifest.resources.d1.migration_owner, "GROUP");
  assert.equal(manifest.resources.d1.apply_migrations_automatically, false);
});

test("manifest leaves Access identity and Cloudflare resource facts pending", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.equal(manifest.resources.access.application_id, null);
  assert.equal(manifest.resources.access.hostname, null);
  assert.equal(manifest.resources.access.policy_verified, false);
  assert.equal(manifest.identity.model, "UNDECIDED");
  assert.deepEqual(manifest.identity.allowed_subjects, []);
  assert.equal(manifest.approval.production_comparison_complete, false);
  assert.equal(manifest.approval.explicit_provisioning_approval, false);
});

test("manifest references secret names only and contains no credential values", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  assert.ok(Array.isArray(manifest.secret_references));
  for (const item of manifest.secret_references) {
    assert.equal(typeof item.name, "string");
    assert.equal(item.value, undefined);
    assert.equal(item.secret_value, undefined);
  }
});

test("manifest schema declares a strict, non-deployable template contract", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("resources"));
  assert.ok(schema.required.includes("approval"));
});
