/**
 * message-limits.ts — bounds for full-text Highway messages.
 *
 * Sin's directive (2026-10-09): long messages post in full — no preview
 * split, no truncation, no attachment machinery. The text the caller sends
 * is the text stored in the Firestore doc.
 *
 * Why the 100k cap is safe: worst case 100_000 chars × 4 bytes (UTF-8) =
 * ~400KB, plus doc overhead — comfortably under Firestore's 1 MiB
 * per-document limit. Zero cost: no Storage, no Blaze (lesson #40).
 *
 * Pure module: zero side effects. Tested by message-limits.test.ts via
 * `node --test` (Node 24 strips types natively; no build step).
 */

import { z } from "zod";

/** Max message text length. Shared by the send_message input schema and tests. */
export const MESSAGE_MAX_CHARS = 100_000;

/**
 * Frontend collapses messages longer than this behind tap-to-expand.
 * Readability only — the full text is already in the doc, no fetch needed.
 */
export const COLLAPSE_AFTER_CHARS = 1000;

export const FIRESTORE_DOC_LIMIT_BYTES = 1_048_576;
/** Generous headroom for field names, timestamps, reactions, attachments, etc. */
const DOC_OVERHEAD_BYTES = 65_536;

/** The exact text schema send_message enforces — single source of truth. */
export function messageTextSchema() {
  return z.string().trim().min(1).max(MESSAGE_MAX_CHARS);
}

export function messageByteSize(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Load-bearing invariant: even the largest allowed message must fit in a
 * Firestore document. If this ever returns false, the cap must shrink —
 * never silently truncate.
 */
export function maxMessageFitsInDoc(): boolean {
  return MESSAGE_MAX_CHARS * 4 + DOC_OVERHEAD_BYTES <= FIRESTORE_DOC_LIMIT_BYTES;
}
