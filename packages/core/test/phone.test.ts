import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReceitaPhone,
  normalizeBrazilianLocal,
  buildWaMeLink,
} from "../src/domain/phone";

/**
 * The nono-dígito repair is the highest-leverage line in this codebase: the
 * Receita stores phones in the pre-2016 eight-digit format, and libphonenumber
 * correctly rejects an 8-digit Brazilian mobile. Without the repair the measured
 * mobile rate is ~2.5%; with it, ~70%. These tests exist so that never silently
 * regresses back to "everything is a landline".
 */

test("8-digit numbers starting 6-9 are upgraded to 9 digits", () => {
  assert.equal(normalizeBrazilianLocal("98887777"), "998887777");
  assert.equal(normalizeBrazilianLocal("61234567"), "961234567");
  assert.equal(normalizeBrazilianLocal("71234567"), "971234567");
  assert.equal(normalizeBrazilianLocal("81234567"), "981234567");
});

test("8-digit numbers starting 2-5 are landlines and left alone", () => {
  assert.equal(normalizeBrazilianLocal("32224444"), "32224444");
  assert.equal(normalizeBrazilianLocal("21234567"), "21234567");
  assert.equal(normalizeBrazilianLocal("55554444"), "55554444");
});

test("9-digit numbers pass through untouched", () => {
  assert.equal(normalizeBrazilianLocal("998887777"), "998887777");
});

test("a legacy 8-digit mobile classifies as mobile, not landline", () => {
  const r = classifyReceitaPhone("11", "98887777");
  assert.ok(r, "expected the number to parse");
  assert.equal(r.e164, "+5511998887777");
  assert.equal(r.isMobile, true);
});

test("a landline stays a landline", () => {
  const r = classifyReceitaPhone("11", "32224444");
  assert.ok(r);
  assert.equal(r.e164, "+551132224444");
  assert.equal(r.isMobile, false);
});

test("invalid area codes are rejected rather than guessed", () => {
  // 20, 23, 25, 26, 29, 30 etc. are not assigned.
  assert.equal(classifyReceitaPhone("20", "998887777"), null);
  assert.equal(classifyReceitaPhone("00", "998887777"), null);
  assert.equal(classifyReceitaPhone("", "998887777"), null);
});

test("junk lengths are rejected", () => {
  assert.equal(classifyReceitaPhone("11", "123"), null);
  assert.equal(classifyReceitaPhone("11", "1234567890123"), null);
  assert.equal(classifyReceitaPhone("11", ""), null);
});

test("wa.me links drop the plus", () => {
  assert.equal(buildWaMeLink("+5511998887777"), "https://wa.me/5511998887777");
});
