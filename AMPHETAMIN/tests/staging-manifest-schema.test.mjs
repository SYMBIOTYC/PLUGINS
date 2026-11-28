import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifestSchema } from "../scripts/staging-manifest-validator.mjs";

const schema = JSON.parse(await readFile(
  new URL("../config/staging-provisioning-manifest.schema.json", import.meta.url),
  "utf8"
));
const template = JSON.parse(await readFile(
  new URL("../config/staging-provisioning-manifest.template.json", import.meta.url),
  "utf8"
));

test("accepts the checked-in staging manifest template against the complete JSON Schema", () => {
  const result = validateManifestSchema(template, schema);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("rejects undeclared secret-reference fields at runtime", () => {
  const unsafe = structuredClone(template);
  unsafe.secret_references = [{
    name: "GROUP_API_TOKEN",
    source: "Cloudflare secret store",
    value: null,
    token: "must-never-be-accepted"
  }];

  const result = validateManifestSchema(unsafe, schema);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /additional propert|must NOT have additional properties/i);
});

test("rejects undeclared nested and top-level manifest fields", () => {
  const unsafe = structuredClone(template);
  unsafe.unreviewed_override = true;
  unsafe.resources.workers.amphetamin.bindings.GROUP.secret_value = "not-a-reference";

  const result = validateManifestSchema(unsafe, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

test("rejects missing required manifest properties", () => {
  const unsafe = structuredClone(template);
  delete unsafe.identity.model;

  const result = validateManifestSchema(unsafe, schema);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /required property|must have required property/i);
});
