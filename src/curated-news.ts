// Crew-curated news batch. One Firestore doc, whole-batch replace.
// story_key is the stable id: latest published_at wins, expired rows drop.

import { isEditor } from "./privacy.js";

export const CURATED_DOC = "/system_config/crew_curated";
export const CURATED_MAX_ITEMS = 32;

export interface CuratedItem {
  story_key: string;
  lane: string;
  title: string;
  description: string;
  url: string;
  sources: string[];
  image: string;
  paper: boolean;
  published_at: string;
  expires_at: string | null;
}

export interface CuratedNewsItem {
  title: string;
  url: string;
  source: "OVERHEARD";
  image: string;
  description: string;
}

export function curatedWriter(ctx: { method?: string; bot?: string | null } | null | undefined): string | null {
  if (ctx?.method !== "header_bound" || !ctx.bot || !isEditor(ctx.bot)) return null;
  return ctx.bot;
}

export function parseCuratedItem(raw: unknown): CuratedItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const story_key = clip(o.story_key, 80);
  const title = clip(o.title, 240);
  const url = clip(o.url, 2000);
  if (!story_key || !title || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  const published_at = iso(o.published_at);
  if (!published_at) return null;
  let expires_at: string | null = null;
  if (o.expires_at != null && o.expires_at !== "") {
    expires_at = iso(o.expires_at);
    if (!expires_at) return null;
  }
  const sources = Array.isArray(o.sources)
    ? o.sources.map((s) => clip(s, 80)).filter(Boolean).slice(0, 8)
    : [];
  return {
    story_key, title, url, published_at, expires_at, sources,
    lane: clip(o.lane, 40),
    description: clip(o.description, 500),
    image: clip(o.image, 2000),
    paper: o.paper === true,
  };
}

export function normalizeBatch(raw: unknown, nowMs: number): CuratedItem[] {
  if (!Array.isArray(raw)) return [];
  const live = raw.map(parseCuratedItem).filter((x): x is CuratedItem => !!x)
    .filter((it) => !expired(it, nowMs));
  const latest = new Map<string, CuratedItem>();
  for (const it of live) {
    const prev = latest.get(it.story_key);
    if (!prev || Date.parse(it.published_at) >= Date.parse(prev.published_at)) latest.set(it.story_key, it);
  }
  const order: string[] = [];
  for (const it of live) {
    if (latest.get(it.story_key) === it && !order.includes(it.story_key)) order.push(it.story_key);
  }
  return order.map((k) => latest.get(k)!).slice(0, CURATED_MAX_ITEMS);
}

export function toNewsItems(items: CuratedItem[]): CuratedNewsItem[] {
  return items.map((it) => ({
    title: it.paper && !/^PAPER:\s/i.test(it.title) ? `PAPER: ${it.title}` : it.title,
    url: it.url,
    source: "OVERHEARD",
    image: it.image,
    description: it.description,
  }));
}

export function itemsFromDocFields(fields: Record<string, unknown> | undefined, nowMs: number): CuratedNewsItem[] {
  const raw = fields?.items;
  const text = raw && typeof raw === "object" && "stringValue" in raw && typeof (raw as { stringValue: unknown }).stringValue === "string"
    ? (raw as { stringValue: string }).stringValue : "";
  let parsed: unknown = [];
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = []; }
  }
  return toNewsItems(normalizeBatch(parsed, nowMs));
}

function expired(it: CuratedItem, nowMs: number): boolean {
  if (!it.expires_at) return false;
  const t = Date.parse(it.expires_at);
  return Number.isFinite(t) && nowMs >= t;
}

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function iso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
