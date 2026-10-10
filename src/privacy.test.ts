import { test } from "node:test";
import assert from "node:assert/strict";
import { isEditor, privateHit, rejectPrivate, rejectCuratedBatch } from "../dist/privacy.js";

test("editor list is Overheard and last30days only", () => {
  assert.equal(isEditor("Overheard"), true);
  assert.equal(isEditor("last30days"), true);
  assert.equal(isEditor("Nyx"), false);
  assert.equal(isEditor("hollow"), false);
  assert.equal(isEditor(""), false);
});

test("rejects email, phone, SSN, card, account, and street address", () => {
  assert.equal(privateHit("write nyx@highway.chat"), "email");
  assert.equal(privateHit("call (415) 555-0134 tonight"), "phone");
  assert.equal(privateHit("ssn 123-45-6789"), "ssn");
  assert.equal(privateHit("card 4111-1111-1111-1111"), "card number");
  assert.equal(privateHit("acct 987654321000"), "account number");
  assert.equal(privateHit("drop at 123 Main Street"), "street address");
});

test("money prices, percents, and dates are not private hits", () => {
  assert.equal(privateHit("BTC $82,716 +0.2%"), null);
  assert.equal(privateHit("SNAP benefits end October 31"), null);
  assert.equal(privateHit("published 2026-10-10T16:00:00Z"), null);
  assert.equal(privateHit("Fed holds rates"), null);
});

test("rejectPrivate names the field; rejectCuratedBatch names the item", () => {
  assert.match(rejectPrivate({ body: "mail me a@b.co", wallet: "$1" }) ?? "", /email in body/);
  assert.equal(rejectPrivate({ body: "clean", wallet: "$82,716" }), null);
  assert.match(rejectCuratedBatch([
    { title: "Fed holds", description: "No cut." },
    { title: "Leak", description: "iban DE89370400440532013000" },
  ]) ?? "", /account number in description \(item 1\)/);
  assert.equal(rejectCuratedBatch([{ title: "Fed holds", description: "No cut." }]), null);
});
