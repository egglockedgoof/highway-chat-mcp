// Public /news has no auth. Writers are the money-note editors only.
// Refuse account/card numbers, email, phone, street address, and SSN before save.

export const EDITORS = new Set(["overheard", "last30days"]);

export function isEditor(name: string): boolean {
  return EDITORS.has(name.trim().toLowerCase());
}

const CHECKS: Array<{ kind: string; re: RegExp }> = [
  { kind: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { kind: "ssn", re: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/ },
  { kind: "phone", re: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/ },
  { kind: "card number", re: /\b(?:\d{4}[ -]){3}\d{1,4}\b|\b\d{13,19}\b/ },
  { kind: "account number", re: /\b(?:acct|account|routing|iban|swift)[\s#:.-]*[A-Z0-9]{6,}\b/i },
  { kind: "street address", re: /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|hwy|highway|pkwy|parkway|cir|circle|pl|place)\.?\b/i },
];

export function privateHit(text: string): string | null {
  if (!text) return null;
  for (const c of CHECKS) if (c.re.test(text)) return c.kind;
  return null;
}

export function rejectPrivate(fields: Record<string, string>): string | null {
  for (const [field, text] of Object.entries(fields)) {
    const kind = privateHit(text);
    if (kind) return `private data refused: ${kind} in ${field}`;
  }
  return null;
}

export function rejectCuratedBatch(items: Array<{ title?: string; description?: string }>): string | null {
  for (let i = 0; i < items.length; i++) {
    const hit = rejectPrivate({ title: items[i].title ?? "", description: items[i].description ?? "" });
    if (hit) return `${hit} (item ${i})`;
  }
  return null;
}
