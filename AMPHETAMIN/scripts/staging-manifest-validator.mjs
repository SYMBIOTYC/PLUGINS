import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseWranglerJsonc, parseWranglerToml } from "./staging-preflight.mjs";

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
  const d1 = manifest?.resources?.d1;
  const entries = d1?.expected_migration_blobs;
  const expected = d1?.expected_migrations;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: ["Manifest migration inventory is missing"] };
  }
  if (!Array.isArray(expected) || expected.length === 0 ||
      expected.some((name) => typeof name !== "string" || name.length === 0)) {
    return { ok: false, errors: ["Manifest expected migration list is missing or invalid"] };
  }

  const expectedSet = new Set(expected);
  const seenNames = new Set();
  const seenPaths = new Set();
  if (expectedSet.size !== expected.length) {
    errors.push("Manifest expected migration list contains duplicates");
  }
  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path.startsWith("migrations/") ||
        isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      errors.push(`unsafe migration path: ${String(path)}`);
      continue;
    }
    const name = path.slice("migrations/".length);
    if (!name || name.includes("/") || name.includes("\")) {
      errors.push(`unsafe migration path: ${path}`);
      continue;
    }
    if (seenPaths.has(path) || seenNames.has(name)) {
      errors.push(`duplicate migration inventory entry: ${path}`);
      continue;
    }
    seenPaths.add(path);
    seenNames.add(name);
    if (!expectedSet.has(name)) {
      errors.push(`unexpected migration inventory entry: ${path}`);
    }
  }
  for (const name of expectedSet) {
    if (!seenNames.has(name)) errors.push(`expected migration missing from inventory: ${name}`);
  }
  for (const name of seenNames) {
    if (!expectedSet.has(name)) errors.push(`unexpected migration inventory entry: ${name}`);
  }
  if (entries.length !== expected.length) {
    errors.push("Migration blob inventory count does not match expected migrations");
  }

  let root;
  let migrationsRoot;
  try {
    root = await realpath(resolve(groupRoot));
    migrationsRoot = await realpath(resolve(root, "migrations"));
  } catch {
    return { ok: false, errors: [...errors, "GROUP migrations directory is missing"] };
  }

  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path.startsWith("migrations/") ||
        isAbsolute(path) || path.split(/[\\/]/).includes("..")) continue;
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      errors.push(`unsafe migration path: ${path}`);
      continue;
    }
    let actualPath;
    let source;
    try {
      actualPath = await realpath(absolute);
      const realRel = relative(migrationsRoot, actualPath);
      if (realRel.startsWith(`..${sep}`) || realRel === ".." || isAbsolute(realRel)) {
        errors.push(`migration symlink escapes GROUP migrations directory: ${path}`);
        continue;
      }
      source = await readFile(actualPath);
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

  const authorizationFlags = [
    manifest?.metadata?.provisioning_authorized,
    manifest?.metadata?.deploy_authorized,
    manifest?.approval?.production_comparison_complete,
    manifest?.approval?.proposed_names_confirmed_unique,
    manifest?.approval?.identity_model_approved,
    manifest?.approval?.explicit_provisioning_approval,
    manifest?.approval?.access_policy_verified,
    manifest?.approval?.d1_migration_approval,
    manifest?.approval?.edge_smoke_test_approval,
    manifest?.approval?.deploy_allowed
  ];
  add(authorizationFlags.length === 10 && authorizationFlags.every((flag) => flag === false),
    "Manifest authorization flags must remain false");
  add(manifest?.resources?.access?.policy_verified === false,
    "Manifest Access policy verification must remain false");
  add(manifest?.identity?.model === "UNDECIDED",
    "Manifest identity model must remain UNDECIDED until separately approved");

  add(amp.ingress?.workers_dev === false, "Manifest must disable AMPHETAMIN workers.dev ingress");
  add(amp.ingress?.preview_urls === false, "Manifest must disable AMPHETAMIN Preview URLs");
  add(group.ingress?.workers_dev === false, "Manifest must disable GROUP workers.dev ingress");
  add(group.ingress?.preview_urls === false, "Manifest must disable GROUP Preview URLs");
  add(stagingAmphetamin?.workers_dev === false, "AMPHETAMIN workers.dev ingress must be disabled");
  add(stagingAmphetamin?.preview_urls === false, "AMPHETAMIN Preview URLs must be disabled");
  add(stagingGroup?.workers_dev === false, "GROUP workers.dev ingress must be disabled");
  add(stagingGroup?.preview_urls === false, "GROUP Preview URLs must be disabled");
  add(stagingGroup?.routes === undefined || (Array.isArray(stagingGroup.routes) && stagingGroup.routes.length === 0),
    "GROUP routes must be absent; GROUP is Service-Binding-only");
  add(stagingGroup?.custom_domain !== true, "GROUP custom domain ingress must be disabled");

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


export async function runStagingManifestValidation({
  manifestPath = "config/staging-provisioning-manifest.template.json",
  ampConfigPath = "wrangler.staging.toml",
  groupConfigPath = "../GROUP/wrangler.staging.jsonc",
  groupRoot = "../GROUP"
} = {}) {
  const [manifestSource, ampSource, groupSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(ampConfigPath, "utf8"),
    readFile(groupConfigPath, "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const ampConfig = parseWranglerToml(ampSource);
  const groupConfig = parseWranglerJsonc(groupSource);
  const topology = validateManifestAgainstConfigs(manifest, ampConfig, groupConfig);
  const migrations = await verifyMigrationInventory(manifest, groupRoot);
  const errors = [...topology.errors, ...migrations.errors];
  return {
    ok: errors.length === 0,
    errors,
    topology_verified: topology.ok,
    migration_blobs_verified: migrations.ok,
    access_policy_verified: false,
    provisioning_authorized: false,
    deployment_authorized: false
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const report = await runStagingManifestValidation();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Staging manifest validation blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
