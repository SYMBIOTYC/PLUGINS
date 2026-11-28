export const TOOL_INVOCATION_REQUEST_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/SYMBIOTYC/PLUGINS/blob/main/contracts/tool-invocation-request-v1.schema.json",
  "title": "SYMBIOTYC Tool Invocation Request v1",
  "description": "Untrusted invocation request. Tenant, actor, scopes, adapter endpoint, credentials and approval claims are derived or verified server-side.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "request_id",
    "tool_id",
    "invocation_id",
    "idempotency_key",
    "input"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "request_id": {
      "type": "string",
      "format": "uuid"
    },
    "tool_id": {
      "type": "string",
      "minLength": 3,
      "maxLength": 128,
      "pattern": "^[a-z0-9][a-z0-9._-]+$"
    },
    "invocation_id": {
      "type": "string",
      "minLength": 3,
      "maxLength": 160,
      "pattern": "^[a-z][a-z0-9._-]+$"
    },
    "idempotency_key": {
      "type": "string",
      "minLength": 16,
      "maxLength": 256,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]+$"
    },
    "approval_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "input": {
      "type": "object",
      "maxProperties": 128
    }
  }
};

export const SKILL_RUN_REQUEST_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/SYMBIOTYC/PLUGINS/blob/main/contracts/skill-run-request-v1.schema.json",
  "title": "SYMBIOTYC Skill Run Request v1",
  "description": "Untrusted request. Tenant, actor and scopes are supplied by the authenticated host principal.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "run_id",
    "skill_id",
    "idempotency_key",
    "input"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "run_id": {
      "type": "string",
      "format": "uuid"
    },
    "skill_id": {
      "type": "string",
      "minLength": 6,
      "maxLength": 128,
      "pattern": "^skill\\.[a-z0-9][a-z0-9._-]*$"
    },
    "idempotency_key": {
      "type": "string",
      "minLength": 16,
      "maxLength": 256,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]+$"
    },
    "input": {
      "type": "object",
      "maxProperties": 128
    },
    "approvals": {
      "type": "object",
      "maxProperties": 64,
      "additionalProperties": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    }
  }
};
