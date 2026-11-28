import test from "node:test";
import assert from "node:assert/strict";
import { validateSchema, assertSchemaSupported, SchemaValidationError } from "../runtime/schema-validator.mjs";

test("validates required object properties and rejects additional properties", () => {
  const schema = { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } }, additionalProperties: false };
  assert.doesNotThrow(() => validateSchema(schema, { name: "AMPHETAMIN" }));
  assert.throws(() => validateSchema(schema, {}), SchemaValidationError);
  assert.throws(() => validateSchema(schema, { name: "AMPHETAMIN", tenant_id: "spoofed" }), SchemaValidationError);
});

test("validates UUID format and string patterns", () => {
  const schema = { type: "object", required: ["request_id", "tool_id"], properties: {
    request_id: { type: "string", format: "uuid" },
    tool_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$" }
  }, additionalProperties: false };
  assert.doesNotThrow(() => validateSchema(schema, { request_id: "f2a8bdb4-9b7e-4b61-9c68-8d6a6f9c1f22", tool_id: "symbiotyc.group" }));
  assert.throws(() => validateSchema(schema, { request_id: "not-a-uuid", tool_id: "symbiotyc.group" }), SchemaValidationError);
  assert.throws(() => validateSchema(schema, { request_id: "f2a8bdb4-9b7e-4b61-9c68-8d6a6f9c1f22", tool_id: "../group" }), SchemaValidationError);
});

test("validates nested additionalProperties schemas", () => {
  const schema = { type: "object", properties: { approvals: { type: "object", maxProperties: 2, additionalProperties: { type: "string", minLength: 1, maxLength: 8 } } }, additionalProperties: false };
  assert.doesNotThrow(() => validateSchema(schema, { approvals: { read: "approval1" } }));
  assert.throws(() => validateSchema(schema, { approvals: { read: "" } }), SchemaValidationError);
});

test("validates arrays, uniqueness and enum values", () => {
  const schema = { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["read", "write"] } };
  assert.doesNotThrow(() => validateSchema(schema, ["read", "write"]));
  assert.throws(() => validateSchema(schema, ["read", "read"]), SchemaValidationError);
  assert.throws(() => validateSchema(schema, ["admin"]), SchemaValidationError);
});

test("supports allOf, anyOf, oneOf and not", () => {
  assert.doesNotThrow(() => validateSchema({ allOf: [{ type: "object" }, { required: ["ok"] }], properties: { ok: { const: true } } }, { ok: true }));
  assert.doesNotThrow(() => validateSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, 7));
  assert.throws(() => validateSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 7), SchemaValidationError);
  assert.throws(() => validateSchema({ not: { const: "blocked" } }, "blocked"), SchemaValidationError);
});

test("fails closed on unsupported schema keywords and malformed schemas", () => {
  assert.throws(() => assertSchemaSupported({ type: "object", patternProperties: { "^x": { type: "string" } } }), SchemaValidationError);
  assert.throws(() => assertSchemaSupported({ type: "object", required: "not-an-array" }), SchemaValidationError);
});
