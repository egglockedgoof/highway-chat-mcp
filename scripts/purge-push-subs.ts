#!/usr/bin/env node
/**
 * One-off: delete Firestore collection highway_push_subs after midnight PT
 * quota reset. Dry-run unless PURGE_PUSH_SUBS=1.
 * Env: FIREBASE_API_KEY, BOT_CREDENTIALS (same names as the bridge). Never logs secrets.
 */
const COLLECTION = "highway_push_subs";
const BASE =
  process.env.FIRESTORE_BASE?.trim() ||
  "https://firestore.googleapis.com/v1/projects/highway-chat/databases/(default)/documents";
const API_KEY = process.env.FIREBASE_API_KEY?.trim() || "";
const live = process.env.PURGE_PUSH_SUBS === "1";

function pacificHour(ms = Date.now()): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hourCycle: "h23",
  }).format(ms);
  return Number(h);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname || "unknown"; }
  catch { return "unknown"; }
}

function creds(): { email: string; password: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(process.env.BOT_CREDENTIALS || ""); }
  catch {
    console.error("FATAL: BOT_CREDENTIALS is not JSON");
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object") {
    console.error("FATAL: BOT_CREDENTIALS is not an object");
    process.exit(1);
  }
  for (const v of Object.values(parsed as Record<string, { email?: string; password?: string }>)) {
    if (v?.email && v?.password) return { email: v.email, password: v.password };
  }
  console.error("FATAL: BOT_CREDENTIALS has no email/password entry");
  process.exit(1);
}

async function idToken(): Promise<string> {
  if (!API_KEY) {
    console.error("FATAL: FIREBASE_API_KEY is not set");
    process.exit(1);
  }
  const { email, password } = creds();
  const r = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const data = await r.json() as { idToken?: string; error?: { message?: string } };
  if (!r.ok || !data.idToken) {
    console.error("FATAL: auth failed");
    process.exit(1);
  }
  return data.idToken;
}

function docIdOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? decodeURIComponent(name.slice(i + 1)) : name;
}

async function listPage(token: string, pageToken?: string): Promise<{ ids: string[]; next?: string }> {
  const u = new URL(`${BASE}/${COLLECTION}`);
  u.searchParams.set("pageSize", "300");
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json() as { documents?: Array<{ name?: string }>; nextPageToken?: string; error?: { message?: string } };
  if (!r.ok) {
    console.error(`FATAL: list ${r.status}`);
    process.exit(1);
  }
  const ids = (data.documents ?? []).map((d) => docIdOf(d.name ?? "")).filter(Boolean);
  return { ids, next: data.nextPageToken };
}

async function del(token: string, id: string): Promise<boolean> {
  const r = await fetch(`${BASE}/${COLLECTION}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`delete ${id} HTTP ${r.status}`);
  return true;
}

const hour = pacificHour();
console.log(`purge-push-subs: host=${hostOf(BASE)} live=${live ? "1" : "0"} pt_hour=${hour}`);
if (hour === 23) {
  console.error("FATAL: 11pm PT — Firestore daily quota may not have reset. Retry after midnight PT.");
  process.exit(1);
}

const token = await idToken();
let page: string | undefined;
let seen = 0;
let removed = 0;
do {
  const { ids, next } = await listPage(token, page);
  for (const id of ids) {
    seen++;
    if (!live) { console.log(`dry-run ${id}`); continue; }
    try {
      if (await del(token, id)) removed++;
    } catch (e) {
      console.warn(`delete failed id=${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  page = next;
} while (page);

console.log(`purge-push-subs: seen=${seen} removed=${live ? removed : 0}`);
if (!live) console.log("dry-run only. Set PURGE_PUSH_SUBS=1 to delete.");
