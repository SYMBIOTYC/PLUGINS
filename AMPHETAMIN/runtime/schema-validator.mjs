const META = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set([
  "type", "const", "enum", "required", "properties", "additionalProperties", "items",
  "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
  "uniqueItems", "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not"
]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const FORMATS = new Set(["uuid", "date-time", "email", "uri"]);

export class SchemaValidationError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = "SchemaValidationError";
    this.path = path;
    this.reason = reason;
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (path, reason) => { throw new SchemaValidationError(path, reason); };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateSchemaShape(schema, path) {
  if (!isRecord(schema)) fail(path, "schema must be an object");
  for (const key of Object.keys(schema)) {
    if (!META.has(key) && !KEYWORDS.has(key)) fail(path, `unsupported schema keyword: ${key}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || !types.every((type) => TYPES.has(type))) fail(path, "schema type is invalid");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))) {
    fail(path, "required must be an array of strings");
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) fail(path, "properties must be an object");
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaShape(child, `${path}.properties.${key}`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    validateSchemaShape(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.items !== undefined) validateSchemaShape(schema.items, `${path}.items`);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) fail(path, `${keyword} must be a non-empty schema array`);
      schema[keyword].forEach((child, index) => validateSchemaShape(child, `${path}.${keyword}[${index}]`));
    }
  }
  if (schema.not !== undefined) validateSchemaShape(schema.not, `${path}.not`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") fail(path, "pattern must be a string");
    try { new RegExp(schema.pattern); } catch { fail(path, "pattern is not a valid regular expression"); }
  }
  if (schema.format !== undefined && !FORMATS.has(schema.format)) fail(path, `unsupported format: ${schema.format}`);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) fail(path, `${key} must be a non-negative integer`);
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) fail(path, `${key} must be a finite number`);
  }
  if (schema.multipleOf !== undefined && schema.multipleOf <= 0) fail(path, "multipleOf must be greater than zero");
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") fail(path, "uniqueItems must be boolean");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) fail(path, "enum must be a non-empty array");
}

export function assertSchemaSupported(schema) {
  validateSchemaShape(schema, "$schema");
  return true;
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  return false;
}

function validateFormat(value, format, path) {
  if (format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(path, "must be a UUID");
  }
  if (format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) {
    fail(path, "must be a date-time");
  }
  if (format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(path, "must be an email");
  if (format === "uri") {
    try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) fail(path, "must be an HTTP(S) URI"); }
    catch { fail(path, "must be a URI"); }
  }
}

function validateValue(schema, value, path) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) fail(path, `must be of type ${types.join(" or ")}`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && canonical(value) !== canonical(schema.const)) fail(path, "does not match const");
  if (schema.enum && !schema.enum.some((item) => canonical(item) === canonical(value))) fail(path, "is not an allowed enum value");

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(path, "is shorter than minLength");
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(path, "is longer than maxLength");
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) fail(path, "does not match pattern");
    if (schema.format !== undefined) validateFormat(value, schema.format, path);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, "is below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, "is above maximum");
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(path, "is not above exclusiveMinimum");
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail(path, "is not below exclusiveMaximum");
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) fail(path, "is not a multipleOf value");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, "has fewer than minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, "has more than maxItems");
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) fail(path, "contains duplicate items");
    if (schema.items) value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) fail(path, "has fewer than minProperties");
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) fail(path, "has more than maxProperties");
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path, `is missing required property ${key}`);
    const properties = schema.properties || {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateValue(childSchema, value[key], `${path}.${key}`);
    }
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) fail(path, `contains unsupported property ${key}`);
      if (isRecord(schema.additionalProperties)) validateValue(schema.additionalProperties, value[key], `${path}.${key}`);
    }
  }
  if (schema.allOf) schema.allOf.forEach((child) => validateValue(child, value, path));
  if (schema.anyOf && !schema.anyOf.some((child) => { try { validateValue(child, value, path); return true; } catch { return false; } })) fail(path, "does not match anyOf");
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => { try { validateValue(child, value, path); return true; } catch { return false; } }).length;
    if (matches !== 1) fail(path, "must match exactly one oneOf branch");
  }
  if (schema.not) {
    try { validateValue(schema.not, value, path); fail(path, "matches a forbidden schema"); } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
      if (error.reason === "matches a forbidden schema") throw error;
    }
  }
}

export function validateSchema(schema, value, path = "$") {
  assertSchemaSupported(schema);
  validateValue(schema, value, path);
  return true;
}
