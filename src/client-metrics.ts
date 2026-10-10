// Widget read metering: each signed-in tab reports how many Firestore documents its
// listeners and one-off reads delivered, so the bridge can show where the project's daily
// read quota actually goes. Counts are self-reported by authenticated clients; they are
// evidence for planning, not billing.

import { quotaDay } from "./read-cache.js";

export const CLIENT_SOURCES = [
  "messages", "presence", "typing", "activity", "tasks", "notes", "dm", "kick", "wins", "other",
] as const;
export type ClientSource = (typeof CLIENT_SOURCES)[number];

export const MAX_REPORT_COUNT = 100_000;
export const MIN_REPORT_INTERVAL_MS = 60_000;
const MAX_REPORTERS = 500;

export function parseReport(body: unknown): Partial<Record<ClientSource, number>> | null {
  const counts = (body as any)?.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const out: Partial<Record<ClientSource, number>> = {};
  for (const [k, v] of Object.entries(counts)) {
    if (!(CLIENT_SOURCES as readonly string[]).includes(k)) return null;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_REPORT_COUNT) return null;
    if (v) out[k as ClientSource] = v as number;
  }
  return out;
}

export function createClientMeter(now: () => number = Date.now) {
  let day = quotaDay(now());
  let bySource: Partial<Record<ClientSource, number>> = {};
  let reporters = new Map<string, number>();
  let lastReport = new Map<string, number>();

  const roll = () => {
    const d = quotaDay(now());
    if (d !== day) { day = d; bySource = {}; reporters = new Map(); }
  };

  // Returns false when the reporter is rate-limited or the reporter table is full.
  function record(uid: string, counts: Partial<Record<ClientSource, number>>): boolean {
    roll();
    const t = now();
    if (t - (lastReport.get(uid) ?? -Infinity) < MIN_REPORT_INTERVAL_MS) return false;
    if (!reporters.has(uid) && reporters.size >= MAX_REPORTERS) return false;
    lastReport.set(uid, t);
    if (lastReport.size > MAX_REPORTERS * 2) lastReport = new Map([...lastReport].slice(-MAX_REPORTERS));
    let sum = 0;
    for (const [k, v] of Object.entries(counts) as [ClientSource, number][]) {
      bySource[k] = (bySource[k] ?? 0) + v;
      sum += v;
    }
    reporters.set(uid, (reporters.get(uid) ?? 0) + sum);
    return true;
  }

  function snapshot() {
    roll();
    const total = Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0);
    return { day, total, bySource: { ...bySource }, reporters: reporters.size };
  }

  return { record, snapshot };
}
