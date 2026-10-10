import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSpec, renderUrl, pickPath, shapeResponse, signSkill, verifySkill, parseRegistry, activeSkills,
  SKILL_RESPONSE_CHARS,
} from "../dist/skills.js";

const weather = {
  name: "weather_now", description: "Current weather for a lat/lon.",
  url: "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true",
  params: [
    { name: "lat", type: "number" as const, description: "latitude", required: true },
    { name: "lon", type: "number" as const, description: "longitude", required: true },
  ],
  pick: "current_weather",
};
const KEY = "test-signing-key";
const active = (spec = weather, reviewedBy = "hollow") => ({
  spec, status: "active" as const, proposedBy: "Proto", proposedVerified: true, proposedAt: 1,
  reviewedBy, reviewedAt: 2, sig: signSkill(KEY, spec, reviewedBy),
});

test("validateSpec accepts a well-formed skill", () => {
  assert.equal(validateSpec(weather), null);
});

test("validateSpec rejects unsafe or malformed templates", () => {
  const bad = (patch: object) => validateSpec({ ...weather, ...patch });
  assert.match(bad({ url: "http://api.open-meteo.com/v1/x" })!, /https/);
  assert.match(bad({ url: "https://{host}/v1/x" })!, /host/);
  assert.match(bad({ url: "https://api.{lat}.com/x" })!, /host/);
  assert.match(bad({ url: "https://user:pw@api.example.com/x" })!, /credentials/);
  assert.match(bad({ url: "https://api.example.com/{nope}" })!, /no matching param/);
  assert.match(bad({ url: "https://api.example.com/{Bad-Name}" })!, /malformed/);
  assert.match(bad({ name: "Weather" })!, /name/);
  assert.match(bad({ pick: "a..b" })!, /pick/);
  assert.match(bad({ params: [weather.params[0], weather.params[0]] })!, /duplicate/);
});

test("renderUrl encodes params and cannot change the host", () => {
  assert.equal(renderUrl(weather, { lat: 40.7, lon: -74 }),
    "https://api.open-meteo.com/v1/forecast?latitude=40.7&longitude=-74&current_weather=true");
  const search = { ...weather, url: "https://api.example.com/search?q={q}", params: [{ name: "q", type: "string" as const, description: "", required: true }] };
  assert.equal(renderUrl(search, { q: "a&b=c @evil.com/" }), "https://api.example.com/search?q=a%26b%3Dc%20%40evil.com%2F");
  const pathy = { ...search, url: "https://api.example.com/{q}" };
  assert.equal(new URL(renderUrl(pathy, { q: "@evil.com" })).host, "api.example.com");
});

test("pickPath and shapeResponse extract, fall back to text, and cap size", () => {
  assert.deepEqual(pickPath({ a: { b: [1, { c: 2 }] } }, "a.b.1"), { c: 2 });
  assert.equal(pickPath({ a: 1 }, "a.b"), undefined);
  assert.deepEqual(shapeResponse(JSON.stringify({ current_weather: { t: 3 } }), "current_weather"), { t: 3 });
  assert.equal(shapeResponse("plain text"), "plain text");
  const big = shapeResponse("x".repeat(SKILL_RESPONSE_CHARS + 50)) as string;
  assert.ok(big.endsWith("…[truncated]") && big.length < SKILL_RESPONSE_CHARS + 20);
});

test("only signed, active, valid entries become tools", () => {
  const reg = {
    ok: active(),
    proposed: { ...active({ ...weather, name: "proposed_one" }), status: "proposed" as const },
    forgedSig: { ...active({ ...weather, name: "forged_one" }), sig: "0".repeat(64) },
    noSig: { ...active({ ...weather, name: "unsigned_one" }), sig: undefined },
  };
  assert.deepEqual(activeSkills(reg, KEY, new Set()).map((s) => s.name), ["weather_now"]);
});

test("editing an approved spec or reviewer outside the bridge voids the signature", () => {
  const e = active();
  assert.equal(verifySkill(KEY, e), true);
  assert.equal(verifySkill(KEY, { ...e, spec: { ...e.spec, url: "https://evil.example.com/x" } }), false);
  assert.equal(verifySkill(KEY, { ...e, reviewedBy: "sin" }), false);
  assert.equal(verifySkill("other-key", e), false);
});

test("parseRegistry tolerates missing or corrupt documents", () => {
  assert.deepEqual(parseRegistry(undefined), {});
  assert.deepEqual(parseRegistry("not json"), {});
  assert.deepEqual(parseRegistry("[1,2]"), {});
  assert.deepEqual(Object.keys(parseRegistry(JSON.stringify({ ok: active() }))), ["ok"]);
});
