export class D1IdempotencyStore {
  constructor(database, namespace) {
    if (!database || typeof database.prepare !== "function") throw new TypeError("D1 database binding is required");
    if (!["tool", "skill"].includes(namespace)) throw new TypeError("idempotency namespace must be tool or skill");
    this.database = database;
    this.namespace = namespace;
  }

  async claim(key, requestHash) {
    const tenantId = key?.tenant_id;
    const idempotencyKey = key?.idempotency_key;
    if (typeof tenantId !== "string" || !tenantId || typeof idempotencyKey !== "string" || !idempotencyKey) {
      throw new TypeError("tenant-scoped idempotency key is required");
    }
    const now = new Date().toISOString();
    const inserted = await this.database.prepare(
      `INSERT INTO runtime_idempotency
        (namespace, tenant_id, idempotency_key, request_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
       ON CONFLICT(namespace, tenant_id, idempotency_key) DO NOTHING
       RETURNING 1 AS claimed`
    ).bind(this.namespace, tenantId, idempotencyKey, requestHash, now, now).first();
    if (inserted) return { state: "claimed", result: null };

    const existing = await this.database.prepare(
      `SELECT request_hash, status, result_json
       FROM runtime_idempotency
       WHERE namespace = ? AND tenant_id = ? AND idempotency_key = ?`
    ).bind(this.namespace, tenantId, idempotencyKey).first();
    if (!existing) throw new Error("idempotency record disappeared after conflict");
    if (existing.request_hash !== requestHash) {
      const error = new Error("idempotency key was already used with a different request");
      error.code = "IDEMPOTENCY_KEY_REUSED";
      error.statusCode = 409;
      throw error;
    }
    if (existing.status === "succeeded") {
      return { state: "replay", result: JSON.parse(existing.result_json) };
    }
    if (existing.status === "unknown") {
      const error = new Error("previous invocation outcome is unknown; reconcile before retry");
      error.code = "OUTCOME_UNKNOWN";
      error.statusCode = 409;
      throw error;
    }
    if (existing.status === "in_progress") {
      const error = new Error("an invocation with this idempotency key is already in progress");
      error.code = "INVOCATION_IN_PROGRESS";
      error.statusCode = 409;
      throw error;
    }
    const error = new Error("previous invocation is terminal and cannot be retried automatically");
    error.code = "INVOCATION_NOT_RETRYABLE";
    error.statusCode = 409;
    throw error;
  }

  async finish(key, status, result = null) {
    if (!["succeeded", "unknown", "failed"].includes(status)) throw new TypeError("invalid idempotency state");
    const tenantId = key.tenant_id;
    const idempotencyKey = key.idempotency_key;
    const resultJson = status === "succeeded" ? JSON.stringify(result) : null;
    const now = new Date().toISOString();
    const update = await this.database.prepare(
      `UPDATE runtime_idempotency
       SET status = ?, result_json = ?, updated_at = ?
       WHERE namespace = ? AND tenant_id = ? AND idempotency_key = ? AND status = 'in_progress'`
    ).bind(status, resultJson, now, this.namespace, tenantId, idempotencyKey).run();
    if (update?.meta?.changes === 1) return true;
    const current = await this.database.prepare(
      `SELECT status FROM runtime_idempotency
       WHERE namespace = ? AND tenant_id = ? AND idempotency_key = ?`
    ).bind(this.namespace, tenantId, idempotencyKey).first();
    if (current?.status === status) return true;
    throw new Error("idempotency state transition was not applied");
  }
}

export class D1AuditSink {
  constructor(database) {
    if (!database || typeof database.prepare !== "function") throw new TypeError("D1 database binding is required");
    this.database = database;
  }

  async append(event) {
    const now = new Date().toISOString();
    const result = await this.database.prepare(
      `INSERT INTO runtime_audit_events
       (event_id, event_type, request_id, run_id, tool_id, invocation_id, skill_id,
        tenant_id, actor_id, side_effect, request_hash, step_count, status, created_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      event.event_type || "runtime.event",
      event.request_id || null,
      event.run_id || null,
      event.tool_id || null,
      event.invocation_id || null,
      event.skill_id || null,
      event.tenant_id,
      event.actor_id,
      event.side_effect || null,
      event.request_hash,
      event.step_count ?? null,
      event.status,
      now,
      JSON.stringify(event)
    ).run();
    if (result?.success === false) throw new Error("D1 audit insert failed");
    return true;
  }
}
