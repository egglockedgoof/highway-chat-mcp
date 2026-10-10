import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, cycleText, type Meters } from "../dist/reflect.js";

const quiet: Meters = {
  day: "2026-10-10",
  bridge: { reads: 0, budget: 20000, overBudget: false, cache: { hits: 0, misses: 7, stale: 0, shared: 0, entries: 0 } },
  widget: { total: 0, reporters: 0, bySource: {} },
};

test("silent widget: do not invent a bottleneck or recommend spending", () => {
  const c = diagnose(quiet);
  assert.equal(c.findings.length, 1);
  assert.equal(c.findings[0].id, "meter-silent");
  assert.equal(c.findings[0].confidence, "hypothesis");
  assert.equal(c.proposals[0].id, "wait-baseline");
  assert.equal(c.proposals.some((p) => /blaze|pay|upgrade/i.test(p.change)), false);
  assert.match(cycleText(c), /Reflection 2026-10-10/);
});

test("presence-dominated widget reads propose a bridge-memory move, not Blaze", () => {
  const c = diagnose({
    ...quiet,
    widget: { total: 1000, reporters: 4, bySource: { presence: 720, messages: 180, typing: 100 } },
  });
  const hot = c.findings.find((f) => f.id === "widget-hot-presence");
  assert.ok(hot);
  assert.equal(hot!.severity, "action");
  assert.match(hot!.hypothesis, /square/);
  assert.match(c.proposals.find((p) => p.findingId === hot!.id)!.change, /bridge/);
  assert.equal(c.proposals.some((p) => /blaze|pay/i.test(p.change + p.risk)), false);
});

test("unlimited tasks listener is named when it dominates", () => {
  const c = diagnose({
    ...quiet,
    widget: { total: 800, reporters: 2, bySource: { tasks: 500, messages: 200, presence: 100 } },
  });
  assert.equal(c.findings[0].id, "widget-hot-tasks");
  assert.match(c.proposals[0].change, /limit/);
});

test("over-budget is an established finding and forbids raising the budget", () => {
  const c = diagnose({
    ...quiet,
    bridge: { ...quiet.bridge, reads: 21000, overBudget: true, cache: { hits: 2, misses: 40, stale: 9, shared: 0, entries: 3 } },
    widget: { total: 10, reporters: 1, bySource: { messages: 10 } },
  });
  const b = c.findings.find((f) => f.id === "bridge-budget");
  assert.ok(b);
  assert.equal(b!.confidence, "established");
  assert.match(c.proposals.find((p) => p.findingId === "bridge-budget")!.change, /Do not raise the budget/);
});

test("cold cache is a watch finding once there is enough traffic", () => {
  const c = diagnose({
    ...quiet,
    bridge: { ...quiet.bridge, cache: { hits: 2, misses: 30, stale: 0, shared: 0, entries: 4 } },
    widget: { total: 20, reporters: 1, bySource: { messages: 20 } },
  });
  assert.ok(c.findings.some((f) => f.id === "cache-cold"));
});

test("steady state when nothing crosses a threshold", () => {
  const c = diagnose({
    ...quiet,
    bridge: { ...quiet.bridge, reads: 400, cache: { hits: 80, misses: 20, stale: 0, shared: 5, entries: 8 } },
    widget: { total: 90, reporters: 2, bySource: { messages: 35, presence: 30, typing: 25 } },
  });
  assert.equal(c.findings[0].id, "steady");
  assert.equal(c.proposals.length, 0);
});
