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

/** Parse the Wrangler TOML subset used by AMPHETAMIN deployment configs. */
export function parseWranglerToml(source) {
  if (typeof source !== "string") throw new TypeError("Wrangler config must be text");
  const config = { vars: {}, services: [], d1_databases: [] };
  let table = config;

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[([A-Za-z0-9_-]+)\]\]$/);
    if (arrayTable) {
      const section = arrayTable[1];
      if (!Array.isArray(config[section])) config[section] = [];
      table = {};
      config[section].push(table);
      continue;
    }

    const namedTable = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (namedTable) {
      const section = namedTable[1];
      if (!config[section] || typeof config[section] !== "object" || Array.isArray(config[section])) {
        config[section] = {};
      }
      table = config[section];
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`Invalid Wrangler TOML syntax at line ${index + 1}`);
    table[assignment[1]] = parseTomlValue(assignment[2], index + 1);
  }

  return config;
}

function stripJsoncComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
    } else {
      output += char;
    }
  }
  return output;
}

/** Parse Wrangler's JSONC config without interpreting comments inside strings. */
export function parseWranglerJsonc(source) {
  if (typeof source !== "string") throw new TypeError("Wrangler JSONC config must be text");
  try {
    return JSON.parse(stripJsoncComments(source));
  } catch (error) {
    throw new Error(`Invalid Wrangler JSONC config: ${error.message}`);
  }
}

function bindings(items, binding) {
  return Array.isArray(items) ? items.filter((item) => item?.binding === binding) : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate both staging Workers as an isolated pair against production.
 * GROUP must remain Service-Binding-only: no workers.dev, previews, or routes.
 * Cloudflare Access policy state is never inferred from repository config.
 */
export function validateStagingConfig(staging, production, stagingGroup, productionGroup) {
  const errors = [];
  const add = (condition, message) => {
    if (!condition) errors.push(message);
  };

  add(staging && typeof staging === "object", "Staging AMPHETAMIN config is missing");
  add(production && typeof production === "object", "Production AMPHETAMIN config is missing");
  add(stagingGroup && typeof stagingGroup === "object", "Staging GROUP config is missing");
  add(productionGroup && typeof productionGroup === "object", "Production GROUP config is missing");
  if (![staging, production, stagingGroup, productionGroup].every((item) => item && typeof item === "object")) {
    return { ok: false, errors, access_policy_verified: false, deployment_gate: "BLOCKED" };
  }

  add(nonEmptyString(staging.name), "Staging Worker name is required");
  add(nonEmptyString(production.name), "Production Worker name is required");
  add(staging.name !== production.name, "Worker name must differ from production");
  add(staging.workers_dev === false, "workers_dev must be false for staging AMPHETAMIN");
  add(staging.preview_urls === false, "preview_urls must be false for staging AMPHETAMIN");

  const stagingGroupBinding = bindings(staging.services, "GROUP");
  const productionGroupBinding = bindings(production.services, "GROUP");
  add(stagingGroupBinding.length === 1 && nonEmptyString(stagingGroupBinding[0]?.service),
    "Exactly one GROUP Service Binding is required");
  add(productionGroupBinding.length === 1 && nonEmptyString(productionGroupBinding[0]?.service),
    "Exactly one production GROUP Service Binding is required for comparison");

  add(nonEmptyString(stagingGroup.name), "Staging GROUP Worker name is required");
  add(nonEmptyString(productionGroup.name), "Production GROUP Worker name is required");
  add(stagingGroup.name !== productionGroup.name, "GROUP Worker name must differ from production");
  add(staging.workers_dev === false, "workers_dev must be false for staging AMPHETAMIN");
  add(stagingGroup.workers_dev === false, "GROUP workers_dev must be false");
  add(stagingGroup.preview_urls === false, "GROUP preview_urls must be false");
  add(!Array.isArray(stagingGroup.routes) || stagingGroup.routes.length === 0,
    "GROUP routes must be absent; GROUP is Service-Binding-only");
  add(stagingGroup.custom_domain !== true, "GROUP custom_domain must not expose a public hostname");

  if (stagingGroupBinding.length === 1) {
    add(stagingGroupBinding[0].service === stagingGroup.name,
      "GROUP Service Binding target must match the staging GROUP Worker name");
    if (productionGroupBinding.length === 1) {
      add(stagingGroupBinding[0].service !== productionGroupBinding[0].service,
        "GROUP Service Binding target must differ from production");
    }
  }

  const stagingAmpDb = bindings(staging.d1_databases, "RUNTIME_DB");
  const productionAmpDb = bindings(production.d1_databases, "RUNTIME_DB");
  const stagingGroupDb = bindings(stagingGroup.d1_databases, "DB");
  const productionGroupDb = bindings(productionGroup.d1_databases, "DB");
  add(stagingAmpDb.length === 1 && nonEmptyString(stagingAmpDb[0]?.database_id),
    "Exactly one RUNTIME_DB D1 binding with database_id is required");
  add(stagingAmpDb.length === 1 && nonEmptyString(stagingAmpDb[0]?.database_name),
    "RUNTIME_DB D1 binding with database_name is required");
  add(productionAmpDb.length === 1 && nonEmptyString(productionAmpDb[0]?.database_id),
    "Production RUNTIME_DB D1 binding is required for comparison");
  add(stagingGroupDb.length === 1 && nonEmptyString(stagingGroupDb[0]?.database_id),
    "Exactly one staging GROUP DB binding is required");
  add(productionGroupDb.length === 1 && nonEmptyString(productionGroupDb[0]?.database_id),
    "Production GROUP DB binding is required for comparison");

  if (stagingAmpDb.length === 1 && productionAmpDb.length === 1) {
    add(stagingAmpDb[0].database_id !== productionAmpDb[0].database_id,
      "D1 database ID must differ from production");
    add(stagingAmpDb[0].database_name !== productionAmpDb[0].database_name,
      "D1 database name must differ from production");
  }
  if (stagingGroupDb.length === 1 && productionGroupDb.length === 1) {
    add(stagingGroupDb[0].database_id !== productionGroupDb[0].database_id,
      "GROUP D1 database ID must differ from production");
  }
  if (stagingAmpDb.length === 1 && stagingGroupDb.length === 1) {
    add(stagingAmpDb[0].database_id === stagingGroupDb[0].database_id &&
      stagingAmpDb[0].database_name === stagingGroupDb[0].database_name,
    "AMPHETAMIN and GROUP must share the same staging D1 database");
  }
  if (productionAmpDb.length === 1 && productionGroupDb.length === 1) {
    add(productionAmpDb[0].database_id === productionGroupDb[0].database_id &&
      productionAmpDb[0].database_name === productionGroupDb[0].database_name,
    "Production AMPHETAMIN and GROUP must share the same production D1 database for comparison");
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
  stagingPath = "AMPHETAMIN/wrangler.staging.toml",
  productionPath = "AMPHETAMIN/wrangler.toml",
  groupStagingPath = "GROUP/wrangler.staging.jsonc",
  groupProductionPath = "GROUP/wrangler.jsonc"
} = {}) {
  const [stagingSource, productionSource, groupStagingSource, groupProductionSource] = await Promise.all([
    readFile(stagingPath, "utf8"),
    readFile(productionPath, "utf8"),
    readFile(groupStagingPath, "utf8"),
    readFile(groupProductionPath, "utf8")
  ]);
  const result = validateStagingConfig(
    parseWranglerToml(stagingSource),
    parseWranglerToml(productionSource),
    parseWranglerJsonc(groupStagingSource),
    parseWranglerJsonc(groupProductionSource)
  );
  return {
    staging_config: stagingPath,
    production_config: productionPath,
    group_staging_config: groupStagingPath,
    group_production_config: groupProductionPath,
    ...result
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const args = process.argv.slice(2);
  const valueAfter = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };

  try {
    const report = await runStagingPreflight({
      stagingPath: valueAfter("--staging", "AMPHETAMIN/wrangler.staging.toml"),
      productionPath: valueAfter("--production", "AMPHETAMIN/wrangler.toml"),
      groupStagingPath: valueAfter("--group-staging", "GROUP/wrangler.staging.jsonc"),
      groupProductionPath: valueAfter("--group-production", "GROUP/wrangler.jsonc")
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Staging preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
