import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDuckDuckGo, parseGoogle, unwrapRedirect } from "../src/domain/serpParse";
import { classifyHit, isStorableKind } from "../src/domain/searchNoise";

/**
 * A real page saved from html.duckduckgo.com, not markup I invented.
 *
 * The whole value of these tests is that they fail when somebody else's markup
 * changes. A hand-written fixture would only ever prove the parser agrees with
 * my guess about the markup, which is the mock-that-agrees-with-the-code
 * problem the rest of this suite avoids.
 */
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

// --------------------------------------------------------------- unwrapping

test("unwrapRedirect pulls the destination out of DDG's wrapper", () => {
  assert.equal(
    unwrapRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fpadaria.com.br%2Fsobre&rut=abc"),
    "https://padaria.com.br/sobre"
  );
});

test("unwrapRedirect pulls the destination out of Google's /url", () => {
  assert.equal(
    unwrapRedirect("/url?q=https://instagram.com/cursinho&sa=U&ved=2a"),
    "https://instagram.com/cursinho"
  );
});

test("unwrapRedirect leaves a direct link alone", () => {
  assert.equal(unwrapRedirect("https://escola.com.br/"), "https://escola.com.br/");
});

// A wrapper host is not a result, and unwrapping has to happen before anything
// classifies the URL — otherwise every hit looks like it came from the engine.
test("unwrapRedirect refuses junk instead of guessing", () => {
  assert.equal(unwrapRedirect(""), null);
  assert.equal(unwrapRedirect("javascript:void(0)"), null);
  assert.equal(unwrapRedirect("#"), null);
});

// ------------------------------------------------------------- DuckDuckGo

test("parseDuckDuckGo reads a real saved results page", () => {
  const page = parseDuckDuckGo(fixture("ddg-results.html"));
  assert.equal(page.status, "ok");
  assert.ok(page.status === "ok" && page.hits.length >= 3, "several results parsed");

  const first = page.status === "ok" ? page.hits[0] : null;
  assert.ok(first);
  assert.match(first.url, /^https:\/\//);
  assert.ok(first.title.length > 10, "title is real text, not markup");
  assert.ok(first.description.length > 20, "snippet came through");
  assert.doesNotMatch(first.title, /</, "tags stripped");
});

test("the saved page decodes entities rather than leaking them", () => {
  const page = parseDuckDuckGo(fixture("ddg-results.html"));
  const all =
    page.status === "ok" ? page.hits.map((h) => h.title + h.description).join(" ") : "";
  assert.doesNotMatch(all, /&amp;|&quot;|&#\d/);
});

// This is the empirical finding that justifies searchNoise existing at all:
// on a real query, most of what comes back is our own data reflected.
test("most results for a company name are CNPJ mirrors", () => {
  const page = parseDuckDuckGo(fixture("ddg-results.html"));
  assert.equal(page.status, "ok");
  const kinds = page.status === "ok" ? page.hits.map((h) => classifyHit(h.url)) : [];
  const aggregators = kinds.filter((k) => k === "aggregator").length;
  assert.ok(aggregators >= 2, `expected mirrors to dominate, got ${JSON.stringify(kinds)}`);
  assert.ok(
    kinds.some((k) => !isStorableKind(k)),
    "and they are excluded as evidence"
  );
});

test("a DDG no-results page is empty, not unrecognized", () => {
  const html = `<html><body><div class="results"><div class="no-results">No results.</div></div></body></html>`;
  assert.equal(parseDuckDuckGo(html).status, "empty");
});

test("a DDG anomaly page is blocked", () => {
  const html = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>`;
  const page = parseDuckDuckGo(html);
  assert.equal(page.status, "blocked");
});

// ------------------------------------------------------------------ Google

/**
 * A real Google results page, saved live.
 *
 * Two bugs were found by running the parser against this and only this. Both
 * were invisible to hand-written markup, and both are the kind that fail
 * silently in production:
 *
 * 1. The block detector matched `/sorry/index` anywhere in the document — and
 *    Google's own client script contains `l.indexOf("/sorry/index")`, checking
 *    whether *it* was redirected. Every successful search was reported as a
 *    CAPTCHA, which would have summoned a human on every row and tripped the
 *    circuit breaker on a working run.
 * 2. The result anchor required the `<h3>` to sit inside the `<a>`. On the real
 *    page the href ends 220-245 characters *before* its title, with divs and a
 *    `<cite>` between them, so zero results parsed.
 *
 * The fixture keeps those `/sorry/index` script fragments on purpose. Stripping
 * them to save bytes would delete the evidence.
 */
test("parseGoogle reads a real saved results page", () => {
  const page = parseGoogle(fixture("google-results.html"));
  assert.equal(page.status, "ok", "a live results page is not a block");
  assert.ok(page.status === "ok" && page.hits.length >= 6);

  const hits = page.status === "ok" ? page.hits : [];
  // Every hit needs a usable snippet: the description is the payload, since it
  // is the only thing that says what a business does.
  for (const hit of hits) {
    assert.match(hit.url, /^https:\/\//);
    assert.ok(hit.title.length > 5, `title for ${hit.url}`);
    assert.ok(hit.description.length > 30, `description for ${hit.url}`);
    assert.doesNotMatch(hit.description, /function\s*\(|getElementById/, "no script leakage");
    assert.doesNotMatch(hit.description, /^https?:\/\//, "snippet is not the cite URL");
  }
});

test("the real page contains /sorry/index in its scripts and is still not blocked", () => {
  const html = fixture("google-results.html");
  // Guard the guard: if a future trim removes these, the test above stops
  // proving anything.
  assert.match(html, /\/sorry\/index/, "fixture must keep the script fragments");
  assert.equal(parseGoogle(html).status, "ok");
});

// The URL is the only definitive block signal, so it wins over the body.
test("a /sorry/ redirect is blocked on the URL alone", () => {
  const page = parseGoogle(
    "<html><body>whatever</body></html>",
    "https://www.google.com/sorry/index?continue=x"
  );
  assert.equal(page.status, "blocked");
});

test("real markup still parses when Google adds a consent host to a link", () => {
  // consent.google.com appearing as a link on a results page is not a consent
  // wall; only being redirected there is.
  const page = parseGoogle(fixture("google-results.html"), "https://www.google.com/search?q=x");
  assert.equal(page.status, "ok");
});

test("parseGoogle reads an organic result", () => {
  const html = `<html><body><div id="search">
    <a href="/url?q=https://instagram.com/mariaraquel.cursos&sa=U">
      <h3>Maria Raquel Ribeiro Marques (@mariaraquel.cursos)</h3>
    </a>
    <div><span>Preparatório para concursos em Manaus. Turmas de segunda a sexta, material incluso e plantão de dúvidas.</span></div>
  </div></body></html>`;

  const page = parseGoogle(html);
  assert.equal(page.status, "ok");
  const hit = page.status === "ok" ? page.hits[0] : null;
  assert.ok(hit);
  assert.equal(hit.url, "https://instagram.com/mariaraquel.cursos");
  assert.match(hit.title, /Maria Raquel Ribeiro Marques/);
  assert.match(hit.description, /concursos em Manaus/);
});

test("a Google CAPTCHA page is blocked, never empty", () => {
  const html = `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`;
  const page = parseGoogle(html);
  assert.equal(page.status, "blocked");
  assert.ok(page.status === "blocked" && /CAPTCHA/i.test(page.reason));
});

test("the Google consent wall is blocked, not empty — in both phrasings", () => {
  for (const phrase of ["Antes de continuar para o Google", "Antes de continuar no Google"]) {
    assert.equal(
      parseGoogle(`<html><body><h1>${phrase}</h1></body></html>`).status,
      "blocked",
      phrase
    );
  }
  // But the phrase alone, without Google, is not a consent wall.
  assert.notEqual(
    parseGoogle("<html><body>antes de continuar leia isto</body></html>").status,
    "blocked"
  );
});

test("a Google no-results page is empty", () => {
  const html = `<html><body><p>did not match any documents</p></body></html>`;
  assert.equal(parseGoogle(html).status, "empty");
});

// -------------------------------------------- the guard the feature rests on

/**
 * The day either engine changes its markup, this is what must happen.
 *
 * An `ok` with zero hits would be recorded as "we searched and this company has
 * no web presence" for every company in the run — hundreds of rows of confident
 * false absence. `unrecognized` makes the caller stop instead.
 */
test("unfamiliar markup is unrecognized, never ok-with-nothing", () => {
  for (const parse of [parseDuckDuckGo, parseGoogle]) {
    assert.equal(parse("").status, "unrecognized", "empty body");
    assert.equal(parse("<html><body><p>oi</p></body></html>").status, "unrecognized");
    assert.equal(parse("not html at all").status, "unrecognized");
    // A results page whose result containers were renamed.
    assert.equal(
      parse(
        `<html><body><div class="brand-new-wrapper"><a href="https://x.com">x</a></div></body></html>`
      ).status,
      "unrecognized"
    );
  }
});

test("no parser ever returns ok with an empty hit list", () => {
  const inputs = [
    "",
    "<html></html>",
    fixture("ddg-results.html"),
    "<div class='result'></div>",
  ];
  for (const parse of [parseDuckDuckGo, parseGoogle]) {
    for (const input of inputs) {
      const page = parse(input);
      if (page.status === "ok") assert.ok(page.hits.length > 0, "ok implies hits");
    }
  }
});

test("search-engine chrome never becomes a result", () => {
  const html = `<html><body><div class="result">
    <a class="result__a" href="https://duckduckgo.com/settings">Settings</a>
    <a class="result__snippet" href="#">nope</a>
  </div></body></html>`;
  // The only candidate was the engine's own page, so nothing was found — and
  // that reads as unrecognized rather than a result.
  assert.notEqual(parseDuckDuckGo(html).status, "ok");
});
