import { test } from "node:test";
import assert from "node:assert/strict";
import {
  websiteFromEmail,
  analyzeHtml,
  phoneFromHtml,
  parseRobots,
  robotsAllows,
  crawlSite,
  HostThrottle,
  mapLimit,
  describeFetchError,
} from "../src/usecases/crawl";
import type { HttpPort } from "../src/ports/index";

/** A fetch stub. No network in tests, and no mock that agrees with the code. */
function stubHttp(routes: Record<string, { status?: number; body?: string }>): HttpPort {
  return {
    async fetch(url: string) {
      const hit = routes[url];
      if (!hit) return new Response("", { status: 404 });
      return new Response(hit.body ?? "", { status: hit.status ?? 200 });
    },
  };
}

test("own-domain e-mails become a website guess", () => {
  assert.equal(websiteFromEmail("contato@suapadaria.com.br"), "https://suapadaria.com.br");
});

test("consumer, typo, government and accountant domains are refused", () => {
  assert.equal(websiteFromEmail("ze@gmail.com"), null);
  assert.equal(websiteFromEmail("ze@hotmail.com.br"), null);
  assert.equal(websiteFromEmail("x@gmai.com"), null);
  assert.equal(websiteFromEmail("x@prefeitura.gov.br"), null);
  assert.equal(websiteFromEmail("x@silvacontabilidade.com.br"), null);
  assert.equal(websiteFromEmail("x@escritoriofiscal.com.br"), null);
  assert.equal(websiteFromEmail("x@algo.cnt.br"), null);
  assert.equal(websiteFromEmail(null), null);
});

test("analyzeHtml reads the signals off the markup", () => {
  const html = `<html><head><meta name="viewport" content="width=device-width">
    <meta name="generator" content="WordPress 6.4"><title>  Padaria  do  Zé </title></head>
    <body><a href="https://wa.me/5511998887777">zap</a><form></form>
    <a href="https://instagram.com/padariadoze">insta</a>
    <p>© 2023 Padaria</p></body></html>`;
  const s = analyzeHtml(html, "https://x.com.br");
  assert.equal(s.hasViewport, true);
  assert.equal(s.hasWaLink, true);
  assert.equal(s.hasForm, true);
  assert.equal(s.platform, "wordpress");
  assert.equal(s.footerYear, 2023);
  assert.equal(s.title, "Padaria do Zé");
  assert.equal(s.igHandle, "padariadoze");
  assert.equal(s.isHttps, true);
});

test("a phone is lifted from the site's own wa.me and tel: links", () => {
  assert.equal(phoneFromHtml(`<a href="https://wa.me/5511998887777">x</a>`), "+5511998887777");
  assert.equal(phoneFromHtml(`<a href="tel:(11) 3222-4444">x</a>`), "+551132224444");
  assert.equal(phoneFromHtml(`<p>sem telefone</p>`), null);
});

test("robots.txt is parsed for our agent and for *", () => {
  const r = parseRobots(`
    User-agent: Googlebot
    Disallow: /nada
    User-agent: *
    Disallow: /admin
    Disallow: /privado
    Crawl-delay: 2
  `);
  assert.deepEqual(r.disallow, ["/admin", "/privado"]);
  assert.equal(r.crawlDelayMs, 2000);
  assert.equal(robotsAllows(r, "/"), true);
  assert.equal(robotsAllows(r, "/admin/x"), false);
  assert.equal(robotsAllows(r, "/publico"), true);
});

test("Disallow: / blocks the whole site", () => {
  const r = parseRobots("User-agent: *\nDisallow: /");
  assert.equal(robotsAllows(r, "/"), false);
  assert.equal(robotsAllows(r, "/qualquer"), false);
});

test("a site that disallows us is not fetched", async () => {
  const http = stubHttp({
    "https://bloqueado.com.br/robots.txt": { body: "User-agent: *\nDisallow: /" },
    "https://bloqueado.com.br": { body: "<html>não deveria ser lido</html>" },
  });
  const s = await crawlSite("https://bloqueado.com.br", { http });
  assert.equal(s.error, "bloqueado por robots.txt");
  assert.equal(s.pagesFetched, 0);
  // Crucially: page signals stay null, not false.
  assert.equal(s.hasViewport, null);
});

test("a link hub short-circuits without a fetch, leaving page signals unknown", async () => {
  let fetched = 0;
  const http: HttpPort = {
    async fetch() {
      fetched++;
      return new Response("", { status: 200 });
    },
  };
  const s = await crawlSite("https://linktr.ee/padaria", { http });
  assert.equal(fetched, 0);
  assert.equal(s.isLinkHub, true);
  assert.equal(s.hasWebsite, true);
  assert.equal(s.hasViewport, null, "never looked, so not false");
});

test("a dead site is data, not an exception", async () => {
  const http = stubHttp({ "https://morto.com.br/robots.txt": { status: 404 } });
  const s = await crawlSite("https://morto.com.br", { http });
  assert.equal(s.isDead, true);
  assert.equal(s.httpStatus, 404);
  assert.equal(s.hasViewport, null);
});

test("depth follows only interesting internal links, and re-caps the text", async () => {
  const home = `<html><body><a href="/contato">contato</a><a href="/blog/post-1">blog</a>
    <a href="https://outro.com/contato">externo</a></body></html>`;
  const http = stubHttp({
    "https://loja.com.br/robots.txt": { status: 404 },
    "https://loja.com.br": { body: home },
    "https://loja.com.br/contato": { body: `<a href="tel:11988887777">liga</a>` },
  });
  const s = await crawlSite("https://loja.com.br", { http, depth: 3 });
  // /blog is not in the interesting set and outro.com is a different host.
  assert.equal(s.pagesFetched, 2);
  assert.equal(s.sitePhone, "+5511988887777");
  assert.ok((s.textExcerpt ?? "").length <= 8000);
});

test("the throttle spaces requests to the same host", async () => {
  const throttle = new HostThrottle(120);
  const t0 = Date.now();
  await throttle.wait("a.com");
  await throttle.wait("b.com"); // different host: no wait
  assert.ok(Date.now() - t0 < 100, "different hosts must not block each other");
  await throttle.wait("a.com");
  assert.ok(Date.now() - t0 >= 120, "same host must wait out the interval");
});

test("accounting firms are caught mid-domain, but ordinary words are not", () => {
  // The anchored pattern alone misses these; they are unmistakably accountants.
  assert.equal(websiteFromEmail("x@silvacontabilidade.com.br"), null);
  assert.equal(websiteFromEmail("x@jrcontabeis.com.br"), null);
  // ...and these must survive: "descritivo" contains "escrit",
  // "distribuidora" is not "tributa".
  assert.equal(websiteFromEmail("x@descritivo.com.br"), "https://descritivo.com.br");
  assert.equal(
    websiteFromEmail("x@distribuidoraabc.com.br"),
    "https://distribuidoraabc.com.br"
  );
});

test("mapLimit keeps input order and respects the concurrency ceiling", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([10, 40, 20, 5, 30], 2, async (ms, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ["0:10", "1:40", "2:20", "3:5", "4:30"]);
  assert.equal(peak, 2, "never more than the limit in flight");
});

test("network failures are named, not reported as 'fetch failed'", () => {
  // "domain does not exist" and "connection refused" lead to opposite decisions
  // about a lead, and Node reports both as the same opaque string.
  const wrap = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.equal(describeFetchError(wrap("ENOTFOUND"), 8000), "domínio não existe");
  assert.equal(describeFetchError(wrap("ECONNREFUSED"), 8000), "conexão recusada");
  assert.equal(describeFetchError(wrap("CERT_HAS_EXPIRED"), 8000), "certificado HTTPS vencido");
  assert.equal(
    describeFetchError(Object.assign(new Error("x"), { name: "AbortError" }), 8000),
    "timeout após 8000ms"
  );
  // An unrecognised cause must not surface the useless default.
  assert.equal(describeFetchError(new TypeError("fetch failed"), 8000), "site inacessível");
});
