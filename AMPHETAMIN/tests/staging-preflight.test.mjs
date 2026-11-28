import test from "node:test";
import assert from "node:assert/strict";
import { parseWranglerJsonc, parseWranglerToml, validateStagingConfig } from "../scripts/staging-preflight.mjs";

const production = {
  name: "symbiotyc-amphetamin-mcp",
  workers_dev: true,
  preview_urls: false,
  vars: {
    COMPUTE_TENANT_ID: "symbiotyc",
    COMPUTE_PROJECT_ID: "compute"
  },
  services: [{ binding: "GROUP", service: "symbiotyc-group-control-plane" }],
  d1_databases: [{
    binding: "RUNTIME_DB",
    database_name: "symbiotyc-group-compute-state",
    database_id: "633d7c14-d335-426c-be7e-2168a43171bc"
  }]
};

const staging = {
  name: "symbiotyc-amphetamin-mcp-staging",
  workers_dev: false,
  preview_urls: false,
  vars: {
    COMPUTE_TENANT_ID: "symbiotyc-staging",
    COMPUTE_PROJECT_ID: "compute-staging"
  },
  services: [{ binding: "GROUP", service: "symbiotyc-group-control-plane-staging" }],
  d1_databases: [{
    binding: "RUNTIME_DB",
    database_name: "symbiotyc-group-compute-state-staging",
    database_id: "733d7c14-d335-426c-be7e-2168a43171bc"
  }]
};


const productionGroup = {
  name: "symbiotyc-group-control-plane",
  workers_dev: false,
  preview_urls: false,
  d1_databases: [{
    binding: "DB",
    database_name: "symbiotyc-group-compute-state",
    database_id: "633d7c14-d335-426c-be7e-2168a43171bc"
  }]
};

const stagingGroup = {
  name: "symbiotyc-group-control-plane-staging",
  workers_dev: false,
  preview_urls: false,
  d1_databases: [{
    binding: "DB",
    database_name: "symbiotyc-group-compute-state-staging",
    database_id: "733d7c14-d335-426c-be7e-2168a43171bc"
  }]
};

test("accepts isolated staging resources and identities", () => {
  const result = validateStagingConfig(staging, production, stagingGroup, productionGroup);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects production Worker name reuse", () => {
  const candidate = { ...staging, name: production.name };
  assert.match(validateStagingConfig(candidate, production, stagingGroup, productionGroup).errors.join(" "), /Worker name/);
});

test("rejects workers.dev and Preview URL ingress", () => {
  const candidate = { ...staging, workers_dev: true, preview_urls: true };
  const errors = validateStagingConfig(candidate, production, stagingGroup, productionGroup).errors.join(" ");
  assert.match(errors, /workers_dev/);
  assert.match(errors, /preview_urls/);
});

test("rejects production GROUP Service Binding reuse", () => {
  const candidate = {
    ...staging,
    services: [{ binding: "GROUP", service: "symbiotyc-group-control-plane" }]
  };
  assert.match(validateStagingConfig(candidate, production, stagingGroup, productionGroup).errors.join(" "), /Service Binding/);
});

test("rejects production D1 database ID or name reuse", () => {
  const sameId = {
    ...staging,
    d1_databases: [{ ...staging.d1_databases[0], database_id: production.d1_databases[0].database_id }]
  };
  const sameName = {
    ...staging,
    d1_databases: [{ ...staging.d1_databases[0], database_name: production.d1_databases[0].database_name }]
  };
  assert.match(validateStagingConfig(sameId, production, stagingGroup, productionGroup).errors.join(" "), /D1 database ID/);
  assert.match(validateStagingConfig(sameName, production, stagingGroup, productionGroup).errors.join(" "), /D1 database name/);
});

test("rejects missing or production tenant/project identifiers", () => {
  const sameTenant = {
    ...staging,
    vars: { ...staging.vars, COMPUTE_TENANT_ID: production.vars.COMPUTE_TENANT_ID }
  };
  const sameProject = {
    ...staging,
    vars: { ...staging.vars, COMPUTE_PROJECT_ID: production.vars.COMPUTE_PROJECT_ID }
  };
  const missing = { ...staging, vars: { COMPUTE_TENANT_ID: "staging" } };
  assert.match(validateStagingConfig(sameTenant, production, stagingGroup, productionGroup).errors.join(" "), /COMPUTE_TENANT_ID/);
  assert.match(validateStagingConfig(sameProject, production, stagingGroup, productionGroup).errors.join(" "), /COMPUTE_PROJECT_ID/);
  assert.match(validateStagingConfig(missing, production, stagingGroup, productionGroup).errors.join(" "), /COMPUTE_PROJECT_ID/);
});

test("rejects missing GROUP or RUNTIME_DB bindings", () => {
  const noGroup = { ...staging, services: [] };
  const noDb = { ...staging, d1_databases: [] };
  assert.match(validateStagingConfig(noGroup, production, stagingGroup, productionGroup).errors.join(" "), /GROUP Service Binding/);
  assert.match(validateStagingConfig(noDb, production, stagingGroup, productionGroup).errors.join(" "), /RUNTIME_DB D1 binding/);
});

test("does not claim to verify Cloudflare Access policy from local config", () => {
  const result = validateStagingConfig(staging, production, stagingGroup, productionGroup);
  assert.equal(result.access_policy_verified, false);
});

test("parses Wrangler root vars, service bindings, and D1 bindings", () => {
  const parsed = parseWranglerToml(`
name = "symbiotyc-amphetamin-mcp-staging"
workers_dev = false
preview_urls = false

[vars]
COMPUTE_TENANT_ID = "tenant-staging"
COMPUTE_PROJECT_ID = "project-staging"

[[services]]
binding = "GROUP"
service = "symbiotyc-group-control-plane-staging"

[[d1_databases]]
binding = "RUNTIME_DB"
database_name = "compute-staging"
database_id = "733d7c14-d335-426c-be7e-2168a43171bc"
`);
  assert.equal(parsed.name, "symbiotyc-amphetamin-mcp-staging");
  assert.equal(parsed.vars.COMPUTE_TENANT_ID, "tenant-staging");
  assert.equal(parsed.services[0].service, "symbiotyc-group-control-plane-staging");
  assert.equal(parsed.d1_databases[0].database_id, "733d7c14-d335-426c-be7e-2168a43171bc");
});

test("rejects malformed Wrangler TOML instead of silently accepting it", () => {
  assert.throws(() => parseWranglerToml("name = [broken"), /Unsupported TOML value/);
});

test("rejects a staging GROUP Worker with public workers.dev or Preview URLs", () => {
  const candidate = { ...stagingGroup, workers_dev: true, preview_urls: true };
  const errors = validateStagingConfig(staging, production, candidate, productionGroup).errors.join(" ");
  assert.match(errors, /GROUP workers_dev/);
  assert.match(errors, /GROUP preview_urls/);
});

test("rejects public routes on the staging GROUP Worker", () => {
  const candidate = { ...stagingGroup, routes: [{ pattern: "group.example.com/*" }] };
  assert.match(
    validateStagingConfig(staging, production, candidate, productionGroup).errors.join(" "),
    /GROUP routes/
  );
});

test("requires staging GROUP Worker name to match the AMPHETAMIN Service Binding target", () => {
  const candidate = { ...stagingGroup, name: "another-group-worker" };
  assert.match(
    validateStagingConfig(staging, production, candidate, productionGroup).errors.join(" "),
    /GROUP Service Binding target/
  );
});

test("requires both staging Workers to share one staging D1 database", () => {
  const candidate = {
    ...stagingGroup,
    d1_databases: [{
      binding: "DB",
      database_name: "different-staging-db",
      database_id: "833d7c14-d335-426c-be7e-2168a43171bc"
    }]
  };
  assert.match(
    validateStagingConfig(staging, production, candidate, productionGroup).errors.join(" "),
    /must share the same staging D1/
  );
});

test("parses GROUP Wrangler JSONC configuration", () => {
  const parsed = parseWranglerJsonc(`{
    // GROUP staging Worker config
    "name": "symbiotyc-group-control-plane-staging",
    "workers_dev": false,
    "preview_urls": false,
    "d1_databases": [{
      "binding": "DB",
      "database_name": "compute-staging",
      "database_id": "733d7c14-d335-426c-be7e-2168a43171bc"
    }]
  }`);
  assert.equal(parsed.name, "symbiotyc-group-control-plane-staging");
  assert.equal(parsed.d1_databases[0].binding, "DB");
});
