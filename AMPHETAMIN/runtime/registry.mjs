export const TOOL_REGISTRY = {
  tools: {
    "symbiotyc.group": {
      status: "verified",
      invocations: {
        health: {
          status: "verified",
          side_effect: "read",
          required_scopes: ["compute:read"],
          input_schema: { type: "object", properties: {}, additionalProperties: false }
        },
        capabilities: {
          status: "verified",
          side_effect: "read",
          required_scopes: ["compute:jobs:read"],
          input_schema: { type: "object", properties: {}, additionalProperties: false }
        },
        get_job: {
          status: "verified",
          side_effect: "read",
          required_scopes: ["compute:jobs:read"],
          input_schema: {
            type: "object",
            required: ["job_id"],
            properties: {
              job_id: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }
            },
            additionalProperties: false
          }
        }
      }
    }
  }
};

export const SKILL_REGISTRY = {
  skills: {
    "skill.symbiotyc.group-health": {
      status: "verified",
      requires_tools: ["symbiotyc.group"],
      requires_invocations: ["health"],
      invocation_sets: [{ tool: "symbiotyc.group", invocations: ["health"] }]
    },
    "skill.symbiotyc.group-capabilities": {
      status: "verified",
      requires_tools: ["symbiotyc.group"],
      requires_invocations: ["capabilities"],
      invocation_sets: [{ tool: "symbiotyc.group", invocations: ["capabilities"] }]
    },
    "skill.symbiotyc.group-get-job": {
      status: "verified",
      requires_tools: ["symbiotyc.group"],
      requires_invocations: ["get_job"],
      invocation_sets: [{ tool: "symbiotyc.group", invocations: ["get_job"] }]
    }
  }
};

const readOutputSchema = {
  type: "object",
  required: ["status_code", "body"],
  properties: {
    status_code: { type: "integer", minimum: 100, maximum: 599 },
    body: { type: "object", maxProperties: 64 }
  },
  additionalProperties: false
};

export const SKILL_DEFINITIONS = {
  "skill.symbiotyc.group-health": {
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: {
      type: "object",
      required: ["status", "service", "protocol", "dispatch_enabled"],
      properties: {
        status: { type: "string", const: "ok" },
        service: { type: "string", const: "symbiotyc-group-control-plane" },
        protocol: { type: "string", const: "symbiotyc.compute.v1" },
        dispatch_enabled: { type: "boolean", const: false }
      },
      additionalProperties: false
    },
    steps: [{ id: "health", tool_id: "symbiotyc.group", invocation_id: "health", input_mapping: {} }],
    output_mapping: {
      status: "steps.health.result.status",
      service: "steps.health.result.service",
      protocol: "steps.health.result.protocol",
      dispatch_enabled: "steps.health.result.dispatch_enabled"
    }
  },
  "skill.symbiotyc.group-capabilities": {
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    output_schema: readOutputSchema,
    steps: [{ id: "capabilities", tool_id: "symbiotyc.group", invocation_id: "capabilities", input_mapping: {} }],
    output_mapping: {
      status_code: "steps.capabilities.result.status_code",
      body: "steps.capabilities.result.body"
    }
  },
  "skill.symbiotyc.group-get-job": {
    input_schema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" }
      },
      additionalProperties: false
    },
    output_schema: readOutputSchema,
    steps: [{
      id: "get_job",
      tool_id: "symbiotyc.group",
      invocation_id: "get_job",
      input_mapping: { job_id: "input.job_id" }
    }],
    output_mapping: {
      status_code: "steps.get_job.result.status_code",
      body: "steps.get_job.result.body"
    }
  }
};
