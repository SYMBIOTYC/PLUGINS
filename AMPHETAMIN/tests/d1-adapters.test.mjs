import test from "node:test";
import assert from "node:assert/strict";
import { D1AuditSink, D1IdempotencyStore } from "../runtime/d1-adapters.mjs";
import { FakeD1 } from "./fake-d1.mjs";

test("D1 idempotency store claims, completes, and replays a tenant-scoped result", async () => {
  const db = new FakeD1();
  const store = new D1IdempotencyStore(db, "tool");
  const key = { tenant_id: "symbiotyc", idempotency_key: "tool:stable-request-0001" };
  assert.equal((await store.claim(key, "a".repeat(64))).state, "claimed");
  await store.finish(key, "succeeded", { status: "ok" });
  const replay = await store.claim(key, "a".repeat(64));
  assert.equal(replay.state, "replay");
  assert.deepEqual(replay.result, { status: "ok" });
});

test("D1 idempotency store rejects payload conflicts and quarantines unknown outcomes", async () => {
  const db = new FakeD1();
  const store = new D1IdempotencyStore(db, "skill");
  const conflictKey = { tenant_id: "symbiotyc", idempotency_key: "skill:stable-request-0001" };
  await store.claim(conflictKey, "a".repeat(64));
  await assert.rejects(() => store.claim(conflictKey, "b".repeat(64)), e => e.code === "IDEMPOTENCY_KEY_REUSED");
  const unknownKey = { tenant_id: "symbiotyc", idempotency_key: "skill:unknown-request-0001" };
  await store.claim(unknownKey, "c".repeat(64));
  await store.finish(unknownKey, "unknown");
  await assert.rejects(() => store.claim(unknownKey, "c".repeat(64)), e => e.code === "OUTCOME_UNKNOWN");
});

test("D1 audit sink appends metadata-only runtime events", async () => {
  const db = new FakeD1();
  const sink = new D1AuditSink(db);
  await sink.append({ event_type: "skill.run", tenant_id: "symbiotyc", actor_id: "access:subject-hash", request_hash: "d".repeat(64), status: "succeeded", step_count: 1 });
  assert.equal(db.auditEvents.length, 1);
  assert.equal(db.auditEvents[0].tenant_id, "symbiotyc");
  assert.equal(db.auditEvents[0].actor_id, "access:subject-hash");
  assert.equal(db.auditEvents[0].status, "succeeded");
  assert.equal(JSON.parse(db.auditEvents[0].metadata_json).email, undefined);
});
