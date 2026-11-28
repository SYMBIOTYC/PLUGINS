import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function stripTomlComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function parseTomlValue(source, lineNumber) {
  const value = source.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Invalid TOML string at line ${lineNumber}`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseTomlValue(item, lineNumber));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  throw new Error(`Unsupported TOML value at line ${lineNumber}`);
}

/**
 * Parse the small Wrangler TOML subset used by the AMPHETAMIN deployment
 * configuration. This is deliberately not a general-purpose TOML parser.
 */
export function parseWranglerToml(source) {
  if (typeof source !== "string") throw new TypeError("Wrangler config must be text");
  const config = { vars: {}, services: [], d1_databases: [] };
  let section = "root";
  let table = config;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[([A-Za-z0-9_-]+)\]\]$/);
    if (arrayTable) {
      section = arrayTable[1];
      if (!Array.isArray(config[section])) config[section] = [];
      table = {};
      config[section].push(table);
      continue;
    }

    const namedTable = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (namedTable) {
      section = namedTable[1];
      if (!config[section] || typeof config[section] !== "object" || Array.isArray(config[section])) {
        config[section] = {};
      }
      table = config[section];
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`Invalid Wrangler TOML syntax at line ${index + 1}`);
    const [, key, rawValue] = assignment;
    table[key] = parseTomlValue(rawValue, index + 1);
  }

  return config;
}

function firstBinding(bindings, binding) {
  return Array.isArray(bindings)
    ? bindings.find((item) => item?.binding === binding)
    : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a staging Worker config against the deployed production config.
 * Access application/policy state is intentionally not inferred from TOML.
 */
export function validateStagingConfig(staging, production) {
  const errors = [];
  const add = (condition, message) => {
    if (!condition) errors.push(message);
  };

  add(staging && typeof staging === "object", "Staging Wrangler config is missing");
  add(production && typeof production === "object", "Production Wrangler config is missing");
  if (!staging || typeof staging !== "object" || !production || typeof production !== "object") {
    return { ok: false, errors, access_policy_verified: false, deployment_gate: "BLOCKED" };
  }

  add(nonEmptyString(staging.name), "Staging Worker name is required");
  add(nonEmptyString(production.name), "Production Worker name is required");
  add(staging.name !== production.name, "Worker name must differ from production");

  add(staging.workers_dev === false, "workers_dev must be false for staging");
  add(staging.preview_urls === false, "preview_urls must be false for staging");

  const stagingGroup = firstBinding(staging.services, "GROUP");
  const productionGroup = firstBinding(production.services, "GROUP");
  add(Boolean(stagingGroup && nonEmptyString(stagingGroup.service)),
    "GROUP Service Binding is required");
  add(Boolean(productionGroup && nonEmptyString(productionGroup.service)),
    "Production GROUP Service Binding is required for comparison");
  if (stagingGroup && productionGroup) {
    add(stagingGroup.service !== productionGroup.service,
      "GROUP Service Binding target must differ from production");
  }

  const stagingDb = firstBinding(staging.d1_databases, "RUNTIME_DB");
  const productionDb = firstBinding(production.d1_databases, "RUNTIME_DB");
  add(Boolean(stagingDb && nonEmptyString(stagingDb.database_id)),
    "RUNTIME_DB D1 binding with database_id is required");
  add(Boolean(stagingDb && nonEmptyString(stagingDb.database_name)),
    "RUNTIME_DB D1 binding with database_name is required");
  add(Boolean(productionDb && nonEmptyString(productionDb.database_id)),
    "Production RUNTIME_DB D1 binding is required for comparison");
  if (stagingDb && productionDb) {
    add(stagingDb.database_id !== productionDb.database_id,
      "D1 database ID must differ from production");
    add(stagingDb.database_name !== productionDb.database_name,
      "D1 database name must differ from production");
  }

  for (const key of ["COMPUTE_TENANT_ID", "COMPUTE_PROJECT_ID"]) {
    const stagingValue = staging.vars?.[key];
    const productionValue = production.vars?.[key];
    add(nonEmptyString(stagingValue), `${key} is required for staging`);
    add(nonEmptyString(productionValue), `${key} is required in production config for comparison`);
    if (nonEmptyString(stagingValue) && nonEmptyString(productionValue)) {
      add(stagingValue !== productionValue, `${key} must differ from production`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    access_policy_verified: false,
    deployment_gate: errors.length === 0
      ? "CONFIG_VALIDATION_ONLY_ACCESS_POLICY_REQUIRES_EXTERNAL_VERIFICATION"
      : "BLOCKED"
  };
}

export async function runStagingPreflight({
  stagingPath = "wrangler.staging.toml",
  productionPath = "wrangler.toml"
} = {}) {
  const [stagingSource, productionSource] = await Promise.all([
    readFile(stagingPath, "utf8"),
    readFile(productionPath, "utf8")
  ]);
  const result = validateStagingConfig(
    parseWranglerToml(stagingSource),
    parseWranglerToml(productionSource)
  );
  return { staging_config: stagingPath, production_config: productionPath, ...result };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const args = process.argv.slice(2);
  const stagingIndex = args.indexOf("--staging");
  const productionIndex = args.indexOf("--production");
  const stagingPath = stagingIndex >= 0 ? args[stagingIndex + 1] : "wrangler.staging.toml";
  const productionPath = productionIndex >= 0 ? args[productionIndex + 1] : "wrangler.toml";

  try {
    const report = await runStagingPreflight({ stagingPath, productionPath });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Staging preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
