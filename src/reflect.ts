// First Reflection Engine cycle: Observe → Understand → Propose.
//
// It reads the live meters (bridge cache + widget reports) and turns them into
// labeled findings. Every finding is a hypothesis until a later cycle records an
// outcome. It never applies a change and never recommends paying for Blaze.
// Test / Approve / Learn are the existing CI, hollow/sin review, and record_lesson.

export type Severity = "info" | "watch" | "action";
export type Confidence = "hypothesis" | "established";

export interface Meters {
  day: string;
  bridge: {
    reads: number;
    budget: number;
    overBudget: boolean;
    cache: { hits: number; misses: number; stale: number; shared: number; entries: number };
  };
  widget: { total: number; reporters: number; bySource: Record<string, number> };
}

export interface Finding {
  id: string;
  severity: Severity;
  problem: string;
  evidence: string[];
  hypothesis: string;
  confidence: Confidence;
}

export interface Proposal {
  id: string;
  findingId: string;
  change: string;
  expected: string;
  test: string;
  risk: string;
}

export interface Cycle {
  day: string;
  findings: Finding[];
  proposals: Proposal[];
  next: string;
}

const share = (part: number, total: number): number => (total > 0 ? part / total : 0);

export function diagnose(m: Meters): Cycle {
  const findings: Finding[] = [];
  const proposals: Proposal[] = [];
  const add = (f: Finding, p?: Omit<Proposal, "findingId">) => {
    findings.push(f);
    if (p) proposals.push({ ...p, findingId: f.id });
  };

  const widgetSilent = m.widget.reporters === 0 && m.widget.total === 0;
  if (widgetSilent) {
    add({
      id: "meter-silent",
      severity: "watch",
      problem: "Widget read meter has no reports yet, so the quota bottleneck is still a hypothesis.",
      evidence: [`widget.reporters=0`, `widget.total=0`, `bridge.reads=${m.bridge.reads}`, `bridge.cache.misses=${m.bridge.cache.misses}`],
      hypothesis: "Open tabs are still on the old script, or the first 5-minute flush has not landed. Do not spend or rebuild storage until this baseline exists.",
      confidence: "hypothesis",
    }, {
      id: "wait-baseline",
      change: "Keep the meter running. Reload remaining Highway tabs. After a few hours of normal use, compare widget_reads.bySource with the Firebase Usage tab.",
      expected: "widget_reads.reporters > 0 and a ranked bySource breakdown that can be checked against Firebase.",
      test: "GET /health shows widget_reads.total > 0. Firebase console daily reads are in the same order of magnitude.",
      risk: "Waiting costs one more quota day. Guessing costs a migration or a bill.",
    });
  } else {
    const ranked = Object.entries(m.widget.bySource).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (top && share(top[1], m.widget.total) >= 0.5) {
      add({
        id: `widget-hot-${top[0]}`,
        severity: top[0] === "presence" || top[0] === "tasks" ? "action" : "watch",
        problem: `Widget source "${top[0]}" is ${Math.round(share(top[1], m.widget.total) * 100)}% of reported reads.`,
        evidence: ranked.slice(0, 4).map(([k, v]) => `${k}=${v}`).concat([`reporters=${m.widget.reporters}`]),
        hypothesis: top[0] === "presence"
          ? "Each tab's presence heartbeat is a read for every other open listener, so cost grows with the square of open tabs."
          : top[0] === "tasks"
            ? "The tasks listener has no limit, so every tab reads the whole highway_tasks collection."
            : `The "${top[0]}" listener is the dominant widget reader.`,
        confidence: "hypothesis",
      }, {
        id: `cut-${top[0]}`,
        change: top[0] === "presence"
          ? "Move presence and typing into the bridge's memory and push them to signed-in tabs. Keep Firestore as fallback."
          : top[0] === "tasks"
            ? "Give the widget tasks listener a limit (newest 50) matching the quest board query."
            : `Cap or debounce the "${top[0]}" listener after measuring a second day.`,
        expected: `${top[0]} share of widget_reads falls below 25% without changing chat behavior.`,
        test: "Same /health comparison on the next quota day. Chat, presence chips, and tasks still update.",
        risk: "A bad presence move could hide people who are online. Keep the existing Firestore path as fallback until hollow reviews authz per room.",
      });
    }
  }

  if (m.bridge.overBudget) {
    add({
      id: "bridge-budget",
      severity: "action",
      problem: "The bridge has already spent its daily read budget and is serving stale cache.",
      evidence: [`reads=${m.bridge.reads}`, `budget=${m.bridge.budget}`, `stale=${m.bridge.cache.stale}`],
      hypothesis: "Agents are polling unique queries that miss the 15s cache, or the budget is set below real need.",
      confidence: "established",
    }, {
      id: "stop-polling",
      change: "Find the hottest caller on get_stats.bridge_reads.byCaller and give that agent cached or push-based reads. Do not raise the budget or switch to Blaze from this finding alone.",
      expected: "bridge.reads stays under budget for a full Pacific day.",
      test: "/health overBudget=false at 06:50 UTC.",
      risk: "Raising the budget hides the leak.",
    });
  }

  const served = m.bridge.cache.hits + m.bridge.cache.misses;
  if (served >= 20 && m.bridge.cache.hits / served < 0.2) {
    add({
      id: "cache-cold",
      severity: "watch",
      problem: "Most bridge reads miss the 15s cache.",
      evidence: [`hits=${m.bridge.cache.hits}`, `misses=${m.bridge.cache.misses}`, `shared=${m.bridge.cache.shared}`],
      hypothesis: "Callers are sending unique limits or filters, or the TTL is shorter than the poll interval.",
      confidence: "hypothesis",
    }, {
      id: "cache-shape",
      change: "Normalize read_messages/list_tasks limits to a small set of page sizes so identical polls share a cache entry.",
      expected: "Cache hit rate above 50% on a normal day.",
      test: "hits/(hits+misses) on /health after 2 hours of traffic.",
      risk: "Over-normalizing could hide a caller that legitimately needs a different page size.",
    });
  }

  if (!findings.length) {
    add({
      id: "steady",
      severity: "info",
      problem: "No bottleneck crosses the action threshold yet.",
      evidence: [`bridge.reads=${m.bridge.reads}`, `widget.total=${m.widget.total}`, `reporters=${m.widget.reporters}`],
      hypothesis: "The system is either quiet or the leak is smaller than the rules can name. Keep measuring.",
      confidence: "hypothesis",
    });
  }

  const next = proposals[0]?.test
    ?? "Reload Highway tabs and re-run reflect after the first widget reports land.";
  return { day: m.day, findings, proposals, next };
}

export function cycleText(c: Cycle): string {
  const f = c.findings.map((x) => `[${x.confidence}/${x.severity}] ${x.problem}`).join(" ");
  const p = c.proposals.map((x) => `${x.id}: ${x.change}`).join(" ");
  return `Reflection ${c.day}. ${f}${p ? ` Propose: ${p}` : ""} Next: ${c.next}`.slice(0, 2000);
}
