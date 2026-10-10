/**
 * Free-tier guardrails for the Supabase move (ARCH_BLUEPRINT 7a).
 * Soft = stay under; hard = vendor cap. In-process; resets on restart.
 */

import { quotaDay } from "./read-cache.js";

export const USAGE_CAPS = {
  realtimeConnections: { soft: 150, hard: 200 },
  realtimeMsgsMonth: { soft: 1_500_000, hard: 2_000_000 },
  egressBytesMonth: { soft: 4 * 1024 * 1024 * 1024, hard: 5 * 1024 * 1024 * 1024 },
} as const;

const pacificMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
});

export function quotaMonth(ms: number): string {
  return pacificMonth.format(ms).slice(0, 7); // YYYY-MM
}

export function createUsageMeter(now: () => number = Date.now) {
  let day = quotaDay(now());
  let month = quotaMonth(now());
  let connections = 0;
  let msgsMonth = 0;
  let egressMonth = 0;

  const roll = () => {
    const t = now();
    const d = quotaDay(t);
    const m = quotaMonth(t);
    if (d !== day) day = d;
    if (m !== month) { month = m; msgsMonth = 0; egressMonth = 0; }
  };

  function addEgress(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    roll();
    egressMonth += bytes;
  }
  function addRealtimeMsg(n = 1) {
    if (!Number.isInteger(n) || n <= 0) return;
    roll();
    msgsMonth += n;
  }
  function setConnections(n: number) {
    connections = Number.isInteger(n) && n >= 0 ? n : connections;
  }
  function snapshot() {
    roll();
    const c = USAGE_CAPS;
    return {
      day,
      month,
      realtime_connections: connections,
      realtime_msgs: msgsMonth,
      egress_bytes: egressMonth,
      caps: {
        realtime_connections: c.realtimeConnections,
        realtime_msgs_month: c.realtimeMsgsMonth,
        egress_bytes_month: c.egressBytesMonth,
      },
      over_soft:
        connections >= c.realtimeConnections.soft ||
        msgsMonth >= c.realtimeMsgsMonth.soft ||
        egressMonth >= c.egressBytesMonth.soft,
    };
  }

  return { addEgress, addRealtimeMsg, setConnections, snapshot };
}
