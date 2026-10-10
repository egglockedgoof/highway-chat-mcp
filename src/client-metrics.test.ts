import { test } from "node:test";
import assert from "node:assert/strict";
import { createClientMeter, parseReport, MIN_REPORT_INTERVAL_MS, MAX_REPORT_COUNT } from "../dist/client-metrics.js";

test("parseReport accepts known sources with non-negative integer counts", () => {
  assert.deepEqual(parseReport({ counts: { presence: 120, messages: 4, typing: 0 } }), { presence: 120, messages: 4 });
});

test("parseReport rejects unknown sources, bad numbers, and bad shapes", () => {
  assert.equal(parseReport({ counts: { bogus: 1 } }), null);
  assert.equal(parseReport({ counts: { presence: -1 } }), null);
  assert.equal(parseReport({ counts: { presence: 1.5 } }), null);
  assert.equal(parseReport({ counts: { presence: MAX_REPORT_COUNT + 1 } }), null);
  assert.equal(parseReport({ counts: [1] }), null);
  assert.equal(parseReport({}), null);
});

test("meter aggregates by source and counts reporters", () => {
  let t = Date.parse("2026-10-10T12:00:00Z");
  const m = createClientMeter(() => t);
  assert.equal(m.record("u1:tabA", { presence: 100, messages: 5 }), true);
  assert.equal(m.record("u1:tabB", { presence: 50 }), true);
  assert.deepEqual(m.snapshot(), { day: "2026-10-10", total: 155, bySource: { presence: 150, messages: 5 }, reporters: 2 });
});

test("each reporter is limited to one report per interval", () => {
  let t = Date.parse("2026-10-10T12:00:00Z");
  const m = createClientMeter(() => t);
  assert.equal(m.record("u1:tab", { presence: 1 }), true);
  assert.equal(m.record("u1:tab", { presence: 1 }), false);
  t += MIN_REPORT_INTERVAL_MS;
  assert.equal(m.record("u1:tab", { presence: 1 }), true);
  assert.equal(m.snapshot().total, 2);
});

test("totals reset on the next Pacific quota day", () => {
  let t = Date.parse("2026-10-10T12:00:00Z");
  const m = createClientMeter(() => t);
  m.record("u1:tab", { messages: 9 });
  t += 24 * 3600 * 1000;
  assert.deepEqual(m.snapshot().bySource, {});
});
