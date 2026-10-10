// Skills: tools the team adds to the bridge at runtime, without a deploy.
//
// An agent proposes a skill as data: a name, a description, typed parameters, and an
// HTTPS GET URL template. An approver on their own bridge token reviews it; approval
// signs the exact spec with a server-held key. Only entries whose signature verifies are
// registered as tools, so a registry document edited outside the bridge cannot activate
// or alter a skill.
//
// Safety envelope: GET only, no caller-supplied headers or credentials, fixed host per
// skill (placeholders are allowed only in the path and query, and are URL-encoded), the
// bridge's public-address guard on every hop, and a capped response.

import { createHmac, timingSafeEqual } from "node:crypto";

export type ParamType = "string" | "number" | "boolean";
export interface SkillParam { name: string; type: ParamType; description: string; required: boolean }
export interface SkillSpec { name: string; description: string; params: SkillParam[]; url: string; pick?: string }
export type SkillStatus = "proposed" | "active" | "rejected" | "retired";
export interface SkillEntry {
  spec: SkillSpec;
  status: SkillStatus;
  proposedBy: string;
  proposedVerified: boolean;
  proposedAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
  sig?: string;
}
export type Registry = Record<string, SkillEntry>;

export const SKILL_PREFIX = "skill_";
export const MAX_SKILLS = 50;
export const MAX_PARAMS = 8;
export const SKILL_RESPONSE_CHARS = 4000;

const NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,29}$/;
const PICK_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,9}$/;
const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]{0,29})\}/g;

export function validateSpec(spec: SkillSpec): string | null {
  if (!NAME_RE.test(spec.name)) return "name must be 3-40 chars of a-z, 0-9, _ and start with a letter";
  if (!spec.description.trim() || spec.description.length > 500) return "description must be 1-500 chars";
  if (spec.params.length > MAX_PARAMS) return `at most ${MAX_PARAMS} params`;
  const names = new Set<string>();
  for (const p of spec.params) {
    if (!PARAM_RE.test(p.name)) return `bad param name "${p.name}"`;
    if (names.has(p.name)) return `duplicate param "${p.name}"`;
    if (!["string", "number", "boolean"].includes(p.type)) return `bad type for "${p.name}"`;
    if (p.description.length > 200) return `description for "${p.name}" over 200 chars`;
    names.add(p.name);
  }
  if (spec.url.length > 500) return "url template over 500 chars";
  const used = [...spec.url.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  for (const u of used) if (!names.has(u)) return `placeholder {${u}} has no matching param`;
  if (/[{}]/.test(spec.url.replace(PLACEHOLDER_RE, ""))) return "url template has a malformed placeholder";
  let u: URL;
  try { u = new URL(spec.url.replace(PLACEHOLDER_RE, "x")); } catch { return "url template is not a valid URL"; }
  if (u.protocol !== "https:") return "url must be https";
  if (u.username || u.password) return "url must not contain credentials";
  const pathAt = spec.url.indexOf("/", "https://".length);
  const origin = pathAt === -1 ? spec.url : spec.url.slice(0, pathAt);
  if (/[{}?#]/.test(origin)) return "placeholders are not allowed in the host";
  if (spec.pick !== undefined && !PICK_RE.test(spec.pick)) return "pick must be a dotted path like data.items";
  return null;
}

export function renderUrl(spec: SkillSpec, args: Record<string, unknown>): string {
  const url = spec.url.replace(PLACEHOLDER_RE, (_, name: string) => {
    const v = args[name];
    return v === undefined || v === null ? "" : encodeURIComponent(String(v));
  });
  const want = new URL(spec.url.replace(PLACEHOLDER_RE, "x")).host;
  if (new URL(url).host !== want) throw new Error("rendered url changed host");
  return url;
}

export function pickPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: any = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

export function shapeResponse(body: string, pick?: string): unknown {
  let out: unknown = body;
  try { out = pickPath(JSON.parse(body), pick); } catch { /* not JSON: return text */ }
  const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
  return text.length > SKILL_RESPONSE_CHARS ? `${text.slice(0, SKILL_RESPONSE_CHARS)}…[truncated]` : out;
}

// Canonical form: fixed key order, so the signature covers exactly what gets registered.
function canonical(spec: SkillSpec, reviewedBy: string): string {
  return JSON.stringify([
    spec.name, spec.description, spec.url, spec.pick ?? null,
    spec.params.map((p) => [p.name, p.type, p.description, p.required]), reviewedBy,
  ]);
}

export function signSkill(key: string, spec: SkillSpec, reviewedBy: string): string {
  return createHmac("sha256", key).update(canonical(spec, reviewedBy)).digest("hex");
}

export function verifySkill(key: string, e: SkillEntry): boolean {
  if (e.status !== "active" || !e.sig || !e.reviewedBy) return false;
  const want = Buffer.from(signSkill(key, e.spec, e.reviewedBy));
  const got = Buffer.from(e.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function parseRegistry(raw: string | undefined): Registry {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Registry) : {};
  } catch { return {}; }
}

export function activeSkills(reg: Registry, key: string, reserved: ReadonlySet<string>): SkillSpec[] {
  return Object.values(reg)
    .filter((e) => e?.spec && verifySkill(key, e) && validateSpec(e.spec) === null && !reserved.has(SKILL_PREFIX + e.spec.name))
    .map((e) => e.spec)
    .slice(0, MAX_SKILLS);
}
