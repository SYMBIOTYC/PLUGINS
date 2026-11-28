import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeGitBlobSha,
  validateManifestAgainstConfigs,
  verifyMigrationInventory
} from "../scripts/staging-manifest-validator.mjs";

const safeManifest = {
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
      amphetamin: { name: "amp-staging", ingress: { workers_dev: false, preview_urls: false } },
      group: { name: "group-staging", ingress: { workers_dev: false, preview_urls: false, routes: [], custom_domains: [], service_binding_only: true } }
    },
    d1: { name: "db-staging", database_id: null }
  },
  identity: { model: "UNDECIDED" }
};

const safeAmp = {
  name: "amp-staging",
  workers_dev: false,
  preview_urls: false,
  routes: [],
  services: [{ binding: "GROUP", service: "group-staging" }],
  d1_databases: [{ binding: "RUNTIME_DB", database_name: "db-staging", database_id: "staging-id" }]
};
const safeGroup = {
  name: "group-staging",
  workers_dev: false,
  preview_urls: false,
  routes: [],
  custom_domain: false,
  d1_databases: [{ binding: "DB", database_name: "db-staging", database_id: "staging-id" }]
};

test("manifest topology validator rejects public AMPHETAMIN ingress", () => {
  for (const unsafe of [
    { ...safeAmp, workers_dev: true },
    { ...safeAmp, preview_urls: true },
  ]) {
    const result = validateManifestAgainstConfigs(safeManifest, unsafe, safeGroup);
    assert.equal(result.ok, false, JSON.stringify(unsafe));
  }
});

test("manifest topology validator rejects undeclared AMPHETAMIN route ingress", () => {
  for (const unsafe of [
    { ...safeAmp, routes: [{ pattern: "amp.example.com/*" }] },
    { ...safeAmp, custom_domain: true }
  ]) {
    const result = validateManifestAgainstConfigs(safeManifest, unsafe, safeGroup);
    assert.equal(result.ok, false, JSON.stringify(unsafe));
  }
});

test("manifest topology validator rejects public GROUP ingress", () => {
  for (const unsafe of [
    { ...safeGroup, workers_dev: true },
    { ...safeGroup, preview_urls: true },
    { ...safeGroup, routes: [{ pattern: "group.example.com/*" }] },
    { ...safeGroup, custom_domain: true }
  ]) {
    const result = validateManifestAgainstConfigs(safeManifest, safeAmp, unsafe);
    assert.equal(result.ok, false, JSON.stringify(unsafe));
  }
});


test("manifest ingress declarations enforce no public GROUP path and no unapproved AMPHETAMIN route", () => {
  const invalidManifests = [
    { ...safeManifest, resources: { ...safeManifest.resources, workers: {
      ...safeManifest.resources.workers,
      amphetamin: { ...safeManifest.resources.workers.amphetamin, ingress: { workers_dev: false, preview_urls: false, public_routes: ["example.com/*"], custom_domains: [] } }
    } } },
    { ...safeManifest, resources: { ...safeManifest.resources, workers: {
      ...safeManifest.resources.workers,
      amphetamin: { ...safeManifest.resources.workers.amphetamin, ingress: { workers_dev: false, preview_urls: false, public_routes: [], custom_domains: ["amp.example.com"] } }
    } } },
    { ...safeManifest, resources: { ...safeManifest.resources, workers: {
      ...safeManifest.resources.workers,
      group: { ...safeManifest.resources.workers.group, ingress: { workers_dev: false, preview_urls: false, routes: ["group.example.com/*"], custom_domains: [], service_binding_only: true } }
    } } },
    { ...safeManifest, resources: { ...safeManifest.resources, workers: {
      ...safeManifest.resources.workers,
      group: { ...safeManifest.resources.workers.group, ingress: { workers_dev: false, preview_urls: false, routes: [], custom_domains: ["group.example.com"], service_binding_only: true } }
    } } },
    { ...safeManifest, resources: { ...safeManifest.resources, workers: {
      ...safeManifest.resources.workers,
      group: { ...safeManifest.resources.workers.group, ingress: { workers_dev: false, preview_urls: false, routes: [], custom_domains: [], service_binding_only: false } }
    } } }
  ];
  for (const manifest of invalidManifests) {
    const result = validateManifestAgainstConfigs(manifest, safeAmp, safeGroup);
    assert.equal(result.ok, false);
  }
});

test("migration inventory must match every expected migration exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "group-migrations-"));
  try {
    await mkdir(join(root, "migrations"));
    const source = "SELECT 1;\n";
    await writeFile(join(root, "migrations", "0001_one.sql"), source);
    const manifest = { resources: { d1: {
      expected_migrations: ["0001_one.sql", "0002_two.sql"],
      expected_migration_blobs: [
        { path: "migrations/0001_one.sql", git_blob_sha: computeGitBlobSha(source) },
        { path: "migrations/0001_one.sql", git_blob_sha: computeGitBlobSha(source) }
      ]
    } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /duplicate|inventory|expected migration/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration inventory rejects symlinks escaping the GROUP checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "group-migrations-"));
  const outside = await mkdtemp(join(tmpdir(), "outside-migration-"));
  try {
    await mkdir(join(root, "migrations"));
    const source = "DROP TABLE protected_data;\n";
    const outsideFile = join(outside, "outside.sql");
    await writeFile(outsideFile, source);
    await symlink(outsideFile, join(root, "migrations", "0001_escape.sql"));
    const manifest = { resources: { d1: {
      expected_migrations: ["0001_escape.sql"],
      expected_migration_blobs: [
        { path: "migrations/0001_escape.sql", git_blob_sha: computeGitBlobSha(source) }
      ]
    } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /symlink|outside|unsafe/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
