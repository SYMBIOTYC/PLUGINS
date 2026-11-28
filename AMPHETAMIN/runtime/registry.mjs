export const TOOL_REGISTRY = {
  tools: {
    "symbiotyc.group": {
      status: "verified",
      invocations: {
        health: {
          status: "verified",
          side_effect: "read",
          required_scopes: ["compute:read"],
          input_schema: {
            type: "object",
            properties: {},
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
      invocation_sets: [
        { tool: "symbiotyc.group", invocations: ["health"] }
      ]
    }
  }
};

export const SKILL_DEFINITIONS = {
  "skill.symbiotyc.group-health": {
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
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
    steps: [
      {
        id: "health",
        tool_id: "symbiotyc.group",
        invocation_id: "health",
        input_mapping: {}
      }
    ],
    output_mapping: {
      status: "steps.health.result.result.status",
      service: "steps.health.result.result.service",
      protocol: "steps.health.result.result.protocol",
      dispatch_enabled: "steps.health.result.result.dispatch_enabled"
    }
  }
};
