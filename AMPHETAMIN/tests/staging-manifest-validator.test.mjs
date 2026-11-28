import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGitBlobSha, verifyMigrationInventory } from "../scripts/staging-manifest-validator.mjs";

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
    ] } } };
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
    ] } } };
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
    ] } } };
    const result = await verifyMigrationInventory(manifest, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /unsafe migration path/);
    assert.match(result.errors.join(" "), /missing migration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
