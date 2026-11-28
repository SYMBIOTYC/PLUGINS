import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function computeGitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

/**
 * Verify pinned GROUP migration Git blob IDs without applying migrations.
 * Paths are confined to the supplied GROUP checkout's migrations directory.
 */
export async function verifyMigrationInventory(manifest, groupRoot) {
  const errors = [];
  const entries = manifest?.resources?.d1?.expected_migration_blobs;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: ["Manifest migration inventory is missing"] };
  }

  const root = resolve(groupRoot);
  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path.startsWith(`migrations/`) ||
        isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      errors.push(`unsafe migration path: ${String(path)}`);
      continue;
    }
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      errors.push(`unsafe migration path: ${path}`);
      continue;
    }
    let source;
    try {
      source = await readFile(absolute);
    } catch {
      errors.push(`missing migration: ${path}`);
      continue;
    }
    const actual = computeGitBlobSha(source);
    if (actual !== entry.git_blob_sha) {
      errors.push(`migration blob SHA mismatch: ${path} expected ${entry.git_blob_sha}, got ${actual}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Ensure both parsed Wrangler configs implement the manifest's proposed topology. */
export function validateManifestAgainstConfigs(manifest, stagingAmphetamin, stagingGroup) {
  const errors = [];
  const amp = manifest?.resources?.workers?.amphetamin;
  const group = manifest?.resources?.workers?.group;
  const d1 = manifest?.resources?.d1;
  const add = (condition, message) => { if (!condition) errors.push(message); };

  add(Boolean(amp && group && d1), "Manifest worker and D1 topology is incomplete");
  if (!amp || !group || !d1) return { ok: false, errors };

  add(stagingAmphetamin?.name === amp.name, "AMPHETAMIN Worker name differs from manifest");
  add(stagingGroup?.name === group.name, "GROUP Worker name differs from manifest");
  const service = stagingAmphetamin?.services?.filter((item) => item?.binding === "GROUP") ?? [];
  add(service.length === 1 && service[0].service === group.name,
    "AMPHETAMIN GROUP Service Binding differs from manifest");

  const ampDb = stagingAmphetamin?.d1_databases?.filter((item) => item?.binding === "RUNTIME_DB") ?? [];
  const groupDb = stagingGroup?.d1_databases?.filter((item) => item?.binding === "DB") ?? [];
  const expectedName = d1.name;
  const expectedId = d1.database_id;
  add(ampDb.length === 1 && ampDb[0].database_name === expectedName &&
    (expectedId === null || ampDb[0].database_id === expectedId),
  "AMPHETAMIN RUNTIME_DB differs from manifest");
  add(groupDb.length === 1 && groupDb[0].database_name === expectedName &&
    (expectedId === null || groupDb[0].database_id === expectedId),
  "GROUP DB differs from manifest");
  add(ampDb.length === 1 && groupDb.length === 1 &&
    ampDb[0].database_id === groupDb[0].database_id &&
    ampDb[0].database_name === groupDb[0].database_name,
  "AMPHETAMIN and GROUP staging D1 bindings do not match");
  return { ok: errors.length === 0, errors };
}
