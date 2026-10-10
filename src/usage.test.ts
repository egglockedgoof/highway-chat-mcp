import { test } from "node:test";
import assert from "node:assert/strict";

const { USAGE_CAPS, createUsageMeter, quotaMonth } = await import("../dist/usage.js");

test("quotaMonth is Pacific YYYY-MM", () => {
  assert.equal(quotaMonth(Date.parse("2026-10-10T12:00:00Z")), "2026-10");
  assert.equal(quotaMonth(Date.parse("2026-11-01T06:30:00Z")), "2026-10"); // still 23:30 PT Oct 31
});

test("caps match 7a soft/hard guardrails", () => {
  assert.equal(USAGE_CAPS.realtimeConnections.soft, 150);
  assert.equal(USAGE_CAPS.realtimeConnections.hard, 200);
  assert.equal(USAGE_CAPS.realtimeMsgsMonth.soft, 1_500_000);
  assert.equal(USAGE_CAPS.realtimeMsgsMonth.hard, 2_000_000);
  assert.equal(USAGE_CAPS.egressBytesMonth.soft, 4 * 1024 * 1024 * 1024);
  assert.equal(USAGE_CAPS.egressBytesMonth.hard, 5 * 1024 * 1024 * 1024);
});

test("usage meter counts egress and flags over_soft", () => {
  let t = Date.parse("2026-10-10T12:00:00Z");
  const u = createUsageMeter(() => t);
  u.addEgress(100);
  u.addRealtimeMsg(3);
  u.setConnections(2);
  const s = u.snapshot();
  assert.equal(s.egress_bytes, 100);
  assert.equal(s.realtime_msgs, 3);
  assert.equal(s.realtime_connections, 2);
  assert.equal(s.over_soft, false);
  u.setConnections(150);
  assert.equal(u.snapshot().over_soft, true);
});

test("monthly counters reset on the next Pacific month", () => {
  let t = Date.parse("2026-10-10T12:00:00Z");
  const u = createUsageMeter(() => t);
  u.addEgress(50);
  u.addRealtimeMsg(9);
  t = Date.parse("2026-11-01T08:00:00Z"); // Nov 1 01:00 PT
  const s = u.snapshot();
  assert.equal(s.month, "2026-11");
  assert.equal(s.egress_bytes, 0);
  assert.equal(s.realtime_msgs, 0);
});
