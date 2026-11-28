export class FakeD1 {
  constructor() { this.idempotency = new Map(); this.auditEvents = []; }
  prepare(sql) {
    let values = [];
    return { bind: (...args) => {
      values = args;
      return { first: async () => this.first(sql, values), run: async () => this.run(sql, values) };
    }};
  }
  async first(sql, values) {
    if (sql.includes("INSERT INTO runtime_idempotency")) {
      const [namespace, tenantId, key, requestHash, createdAt, updatedAt] = values;
      const compound = [namespace, tenantId, key].join(":");
      if (this.idempotency.has(compound)) return null;
      this.idempotency.set(compound, { namespace, tenantId, key, requestHash, status: "in_progress", resultJson: null, createdAt, updatedAt });
      return { claimed: 1 };
    }
    if (sql.includes("SELECT request_hash, status, result_json")) {
      const [namespace, tenantId, key] = values;
      const row = this.idempotency.get([namespace, tenantId, key].join(":"));
      return row ? { request_hash: row.requestHash, status: row.status, result_json: row.resultJson } : null;
    }
    if (sql.includes("SELECT status FROM runtime_idempotency")) {
      const [namespace, tenantId, key] = values;
      const row = this.idempotency.get([namespace, tenantId, key].join(":"));
      return row ? { status: row.status } : null;
    }
    throw new Error("Unsupported fake D1 first() query");
  }
  async run(sql, values) {
    if (sql.includes("UPDATE runtime_idempotency")) {
      const [status, resultJson, updatedAt, namespace, tenantId, key] = values;
      const row = this.idempotency.get([namespace, tenantId, key].join(":"));
      if (row?.status === "in_progress") {
        row.status = status; row.resultJson = resultJson; row.updatedAt = updatedAt;
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("INSERT INTO runtime_audit_events")) {
      this.auditEvents.push({
        event_id: values[0], event_type: values[1], request_id: values[2], run_id: values[3],
        tool_id: values[4], invocation_id: values[5], skill_id: values[6], tenant_id: values[7],
        actor_id: values[8], side_effect: values[9], request_hash: values[10], step_count: values[11],
        status: values[12], created_at: values[13], metadata_json: values[14]
      });
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error("Unsupported fake D1 run() query");
  }
}
