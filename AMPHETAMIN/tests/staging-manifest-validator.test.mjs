import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeGitBlobSha,
  validateManifestAgainstConfigs,
  verifyMigrationInventory
} from "../scripts/staging-manifest-validator.mjs";

test("computes Git blob SHA using Git's blob object framing", () => {
  assert.equal(computeGitBlobSha("test\n"), "9daeafb9864cf43055ae93beb0afd6c7d144bfa4");
});

test("accepts a manifest migration inventory when every pinned blob matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "group-migrations-"));
  try {
    await mkdir(join(root, "migrations"));
    const source = "CREATE TABLE example (id TEXT PRIMARY KEY);\n";
    await writeFile(join(root, "migrations", "0001_example.sql"), source);
    const manifest = { resources: { d1: { expected_migration_blobs: [
      { path: "migrations/0001_example.sql", git_blob_sha: computeGitBlobSha(source) }
    ], expected_migrations: ["0001_example.sql"] } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks a manifest when a pinned migration blob differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "group-migrations-"));
  try {
    await mkdir(join(root, "migrations"));
    await writeFile(join(root, "migrations", "0001_example.sql"), "SELECT 1;\n");
    const manifest = { resources: { d1: { expected_migration_blobs: [
      { path: "migrations/0001_example.sql", git_blob_sha: "0".repeat(40) }
    ], expected_migrations: ["0001_example.sql"] } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /blob SHA mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocks missing migration files and unsafe paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "group-migrations-"));
  try {
    const manifest = { resources: { d1: { expected_migration_blobs: [
      { path: "../outside.sql", git_blob_sha: "0".repeat(40) },
      { path: "migrations/0002_missing.sql", git_blob_sha: "0".repeat(40) }
    ], expected_migrations: ["0002_missing.sql"] } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /unsafe migration path/);
    assert.match(result.errors.join(" "), /missing migration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const manifest = {
  metadata: { provisioning_authorized: false, deploy_authorized: false },
  approval: {
    production_comparison_complete: false,
    proposed_names_confirmed_unique: false,
    identity_model_approved: false,
    explicit_provisioning_approval: false,
    access_policy_verified: false,
    d1_migration_approval: false,
    edge_smoke_test_approval: false,
    deploy_allowed: false
  },
  resources: {
    access: { policy_verified: false },
    workers: {
      amphetamin: { name: "amp-staging" },
      group: { name: "group-staging" }
    },
    d1: { name: "db-staging", database_id: null }
  },
  identity: { model: "UNDECIDED" }
};
const amp = {
  name: "amp-staging",
  services: [{ binding: "GROUP", service: "group-staging" }],
  d1_databases: [{ binding: "RUNTIME_DB", database_name: "db-staging", database_id: "staging-id" }]
};
const group = {
  name: "group-staging",
  d1_databases: [{ binding: "DB", database_name: "db-staging", database_id: "staging-id" }]
};

test("accepts paired Wrangler configs matching the manifest topology", () => {
  const result = validateManifestAgainstConfigs(manifest, amp, group);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects a Service Binding target that diverges from the manifest", () => {
  const result = validateManifestAgainstConfigs(manifest, {
    ...amp, services: [{ binding: "GROUP", service: "production-group" }]
  }, group);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /Service Binding differs/);
});

test("rejects a D1 binding that diverges from the manifest", () => {
  const result = validateManifestAgainstConfigs(manifest, amp, {
    ...group, d1_databases: [{ binding: "DB", database_name: "production-db", database_id: "staging-id" }]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /GROUP DB differs/);
});

test("does not accept a missing manifest topology", () => {
  const result = validateManifestAgainstConfigs({}, amp, group);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /topology is incomplete/);
});

test("blocks manifests that enable provisioning or deployment before approval", () => {
  const unsafe = {
    ...manifest,
    metadata: { provisioning_authorized: true, deploy_authorized: false },
    approval: { explicit_provisioning_approval: false, deploy_allowed: false },
    resources: {
      ...manifest.resources,
      access: { policy_verified: false }
    },
    identity: { model: "UNDECIDED" }
  };
  const result = validateManifestAgainstConfigs(unsafe, amp, group);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /authorization flags must remain false/);
});
