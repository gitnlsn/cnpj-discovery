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
  emailsFromHtml,
  phonesFromHtml,
  rankEmails,
} from "../src/usecases/crawl";
import { describeFetchError } from "../src/domain/netError";
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

// ------------------------------------------------- JS shells and declared text

const PROBES = [
  { key: "enem", label: "ENEM", terms: ["enem"], meaning: "positive" as const, weight: 1 },
];

/**
 * The case this was built for: 200 OK, a mount point, and nothing rendered.
 *
 * Before, the nav text was non-empty, so the pipeline sent it to the model with
 * a full set of `false` probes — recording "we could not read it" as "it is not
 * there".
 */
test("a JS shell is flagged, and its probes stay unknown rather than false", async () => {
  const shell = `<html><head><title>Cursinho</title></head>
    <body><div id="__next"></div><script>window.__NEXT_DATA__={}</script></body></html>`;
  const http = stubHttp({
    "https://shell.com.br/robots.txt": { status: 404 },
    "https://shell.com.br": { body: shell },
  });

  const s = await crawlSite("https://shell.com.br", { http, probes: PROBES });
  assert.equal(s.isJsShell, true);
  assert.equal(s.structuredText, null);
  // Not { enem: false } — nothing was legible, so nothing was concluded.
  assert.deepEqual(s.probes, {});
});

test("a shell that declares a description is still readable", async () => {
  const shell = `<html><head><title>Cursinho</title>
    <meta name="description" content="Turmas preparatórias para o ENEM em Manaus.">
    </head><body><div id="root"></div></body></html>`;
  const http = stubHttp({
    "https://shell2.com.br/robots.txt": { status: 404 },
    "https://shell2.com.br": { body: shell },
  });

  const s = await crawlSite("https://shell2.com.br", { http, probes: PROBES });
  assert.equal(s.isJsShell, true, "still a shell");
  assert.equal(s.metaDescription, "Turmas preparatórias para o ENEM em Manaus.");
  // The declared text rescues it: the probe is now answerable.
  assert.deepEqual(s.probes, { enem: true });
});

// The regression guard: Parts A and B must not perturb a page that already read
// fine. Probes, text, and the shell flag all behave as before.
test("a normal content page is not a shell and probes unchanged", async () => {
  const body = "conteúdo real ".repeat(60);
  const page = `<html><head><title>Colégio</title></head><body><p>${body}ENEM</p></body></html>`;
  const http = stubHttp({
    "https://real.com.br/robots.txt": { status: 404 },
    "https://real.com.br": { body: page },
  });

  const s = await crawlSite("https://real.com.br", { http, probes: PROBES });
  assert.equal(s.isJsShell, false);
  assert.equal(s.metaDescription, null);
  assert.equal(s.jsonLd, null);
  assert.deepEqual(s.probes, { enem: true });
  assert.ok((s.textExcerpt ?? "").length > 400);
});

// A long page that happens to mount React is not a shell — the text is the test,
// the mount point only disambiguates a short one.
test("a mount point on a page that rendered is not a shell", async () => {
  const page = `<html><body><div id="root"><p>${"texto ".repeat(200)}</p></div></body></html>`;
  const http = stubHttp({
    "https://spa.com.br/robots.txt": { status: 404 },
    "https://spa.com.br": { body: page },
  });
  assert.equal((await crawlSite("https://spa.com.br", { http })).isJsShell, false);
});

// A thin page with no mount point is thin, not a shell — that distinction is
// what keeps `isJsShell` meaning "JavaScript ate the content".
test("a short plain page is thin but not a shell", async () => {
  const http = stubHttp({
    "https://tiny.com.br/robots.txt": { status: 404 },
    "https://tiny.com.br": { body: "<html><body><p>Em breve.</p></body></html>" },
  });
  const s = await crawlSite("https://tiny.com.br", { http, probes: PROBES });
  assert.equal(s.isJsShell, false);
  assert.deepEqual(s.probes, { enem: false }, "we did read it, and the term is absent");
});

test("crawlSite surfaces JSON-LD from the page", async () => {
  const ld = JSON.stringify({
    "@type": "School",
    name: "Colégio Alfa",
    description: "Preparatório para concursos.",
  });
  const page = `<html><head><script type="application/ld+json">${ld}</script></head>
    <body><p>${"aula ".repeat(120)}</p></body></html>`;
  const http = stubHttp({
    "https://alfa.com.br/robots.txt": { status: 404 },
    "https://alfa.com.br": { body: page },
  });

  const s = await crawlSite("https://alfa.com.br", { http });
  assert.equal(s.jsonLd?.name, "Colégio Alfa");
  assert.match(s.structuredText ?? "", /Preparatório para concursos/);
});

// Link hubs never get fetched (crawl.ts short-circuits them), so every page
// signal including the new ones must stay null — not false, not empty.
test("a link hub leaves the new signals unknown", async () => {
  const s = await crawlSite("https://instagram.com/cursinhodoze", { http: stubHttp({}) });
  assert.equal(s.isLinkHub, true);
  assert.equal(s.isJsShell, null, "never fetched, so unknown");
  assert.equal(s.structuredText, null);
  assert.equal(s.metaDescription, null);
});

// ----------------------------------------- domains that are not the company's

/**
 * Every one of these was measured in the live base, not imagined.
 *
 * A dead guess is harmless — the crawl fails and the signals stay null. These
 * are the guesses that SUCCEED and hand the scorer somebody else's page as this
 * company's website, which is fabricated evidence and much worse than nothing.
 */
test("mistyped consumer providers never become a website", () => {
  for (const email of [
    "x@homail.com", // missing t
    "x@gmil.com", // missing a
    "x@outook.com", // missing l
    "x@gmail.con", // the TLD is the typo, so a valid-TLD anchor could not match
  ]) {
    assert.equal(websiteFromEmail(email), null, email);
  }
});

// yahoo.es, yahoo.fr and yahoo.it were each crawled and each returned ~2.5 KB
// of Yahoo's national portal.
test("a consumer provider on a foreign suffix is still a consumer provider", () => {
  for (const email of ["x@yahoo.es", "x@yahoo.fr", "x@yahoo.it", "x@hotmail.co.uk"]) {
    assert.equal(websiteFromEmail(email), null, email);
  }
});

/**
 * The most expensive one, because it worked: `unicesumar.edu.br` was crawled as
 * a company's site and read 8,000 characters of a real university's homepage —
 * which scores like a substantial, professional operation.
 */
test("an institutional address belongs to the institution, not the person", () => {
  for (const email of [
    "x@unicesumar.edu.br",
    "x@uni9.edu.br",
    "x@ifma.edu.br",
    "x@adv.oabsp.org.br",
    "x@tribunal.jus.br",
  ]) {
    assert.equal(websiteFromEmail(email), null, email);
  }
});

test("a real company domain still passes all of it", () => {
  assert.equal(websiteFromEmail("contato@cursinhoalfa.com.br"), "https://cursinhoalfa.com.br");
  assert.equal(websiteFromEmail("vendas@suapadaria.com.br"), "https://suapadaria.com.br");
});

/**
 * Os contatos que a varredura da internet aberta entrega.
 *
 * O viés é precisão, e o motivo é concreto: esta lista vai virar a mensagem que
 * alguém manda. Um e-mail errado aqui escreve para um estranho — o autor do tema
 * do site, o fornecedor de analytics — então é melhor faltar do que sobrar.
 */
test("extrai e-mails de contato e descarta os que não são da empresa", () => {
  const emails = emailsFromHtml(`
    <a href="mailto:contato@kaits.com.br">Fale conosco</a>
    <a href="mailto:vendas@kaits.com.br?subject=Ola">Vendas</a>
    <img src="/logo@2x.png">
    <span>suporte@example.com</span>
    <span>a@b.co</span>
    <span>theme@wixpress.com</span>
  `);
  assert.deepEqual(emails, ["contato@kaits.com.br", "vendas@kaits.com.br"]);
});

test("extrai telefones deliberados e ignora CNPJ e CEP", () => {
  const phones = phonesFromHtml(`
    <a href="https://wa.me/5511998877665">WhatsApp</a>
    <a href="tel:+551140028922">(11) 4002-8922</a>
    <p>ou (21) 3333-4444</p>
    <p>CNPJ 12.345.678/0001-99 · CEP 01310100</p>
  `);
  // O wa.me vem primeiro por ser o mais deliberado, e o número repetido em
  // texto não entra duas vezes.
  assert.deepEqual(phones, ["+5511998877665", "+551140028922", "+552133334444"]);
});

test("o e-mail do próprio domínio vem primeiro, o da agência por último", () => {
  // Medido num site real: `fuse@fuse.com.br` no rodapé de uma administradora de
  // condomínios. Estruturalmente é idêntico a um contato de verdade; o que o
  // distingue é de QUEM é o domínio.
  //
  // Ordenar, e não excluir: uma versão anterior descartava domínio de terceiro e
  // com isso perdia o contato de uma empresa em `marca.com.br` cujo e-mail é
  // `contato@grupomarca.com.br`. Contato ausente é lead inacionável; contato
  // estranho no fim de uma lista de oito, onde a tela mostra os dois primeiros,
  // custa quase nada.
  const html = `
    <a href="mailto:%20atendimento@selladm.com.br">contato</a>
    <p>fuse@fuse.com.br construiu · dono@gmail.com</p>`;
  const out = emailsFromHtml(html, "www.selladm.com.br");
  assert.equal(out[0], "atendimento@selladm.com.br", "o do próprio domínio manda");
  assert.equal(out[1], "dono@gmail.com", "free-mail é contato real para negócio pequeno");
  assert.equal(out[2], "fuse@fuse.com.br", "domínio de terceiro fica por último");
});

test("versão de biblioteca em CDN não é e-mail", () => {
  // Medido numa rodada real: `bootstrap@5.3.3` e `bootstrap-icons@1.10.5`
  // entraram como contato, porque `5.3.3` parece um domínio. O último rótulo tem
  // de ser LETRAS. E o corpo de <script> sai inteiro: o e-mail do autor de uma
  // biblioteca (`hey@craftpip.com`, também real) não é contato de ninguém aqui, e
  // não é visível para quem lê a página — que é o teste do que é um contato.
  const html = `
    <script>var l="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/x.js"; // hey@craftpip.com </script>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/x.css">
    <a href="mailto:contato@getusp.com.br">Contato</a>
    <p>Ou fale com sa.concursos@yahoo.com.br</p>`;
  assert.deepEqual(emailsFromHtml(html, "getusp.com.br"), [
    "contato@getusp.com.br",
    "sa.concursos@yahoo.com.br",
  ]);
});

test("e-mail escondido com entidade HTML é lido inteiro", () => {
  // Site real obfusca a última letra para derrotar raspador: `.com.b&#114;` vinha
  // como `.com.b`, um domínio truncado com cara de endereço bom.
  const out = emailsFromHtml("<p>carolina@predicado.com.b&#114;</p>", "graiche.com.br");
  assert.deepEqual(out, ["carolina@predicado.com.br"]);
});

test("comentário HTML não vira contato", () => {
  const out = emailsFromHtml(
    "<!-- theme by hey@craftpip.com --><a href='mailto:contato@alfa.com.br'>c</a>",
    "alfa.com.br"
  );
  assert.deepEqual(out, ["contato@alfa.com.br"]);
});

test("a ordenação sobrevive à junção de várias páginas", () => {
  // `mergeContacts` concatena, então sem re-ordenar no fim o e-mail de terceiro
  // achado na página 1 fica acima do da própria empresa achado na página 3 — foi
  // o que colocou `hey@craftpip.com` na frente do contato real.
  assert.deepEqual(
    rankEmails(["hey@craftpip.com", "sa@yahoo.com.br", "contato@sa.com.br"], "sa.com.br"),
    ["contato@sa.com.br", "sa@yahoo.com.br", "hey@craftpip.com"]
  );
});

test("e-mail num domínio irmão não é perdido", () => {
  // O caso que motivou a mudança: o site é marca.com.br e o contato é do grupo.
  const out = emailsFromHtml("<p>contato@grupomarca.com.br</p>", "marca.com.br");
  assert.deepEqual(out, ["contato@grupomarca.com.br"]);
});

test("o %20 do mailto não vira parte do endereço, nem uma segunda entrada", () => {
  // Sem excluir os hrefs da varredura de texto, `%20foo@x` casava de novo do meio
  // e produzia `20foo@x` — o mesmo endereço com um caractere de lixo.
  const out = emailsFromHtml('<a href="mailto:%20ola@alfa.com.br">x</a>', "alfa.com.br");
  assert.deepEqual(out, ["ola@alfa.com.br"]);
});

test("telefone de placeholder é descartado", () => {
  // `+5599999999999` veio de um site real.
  assert.deepEqual(phonesFromHtml('<a href="tel:+5599999999999">x</a>'), []);
  assert.deepEqual(phonesFromHtml('<a href="tel:+551130813244">x</a>'), ["+551130813244"]);
});

test("um dígito solto em texto não vira telefone", () => {
  // Sem os parênteses do DDD, uma corrida de 11 dígitos em texto brasileiro é
  // tão provavelmente um pedaço de CNPJ quanto um telefone.
  assert.deepEqual(phonesFromHtml("<p>11998877665</p>"), []);
  assert.deepEqual(emailsFromHtml("<p>sem email aqui</p>"), []);
});

/**
 * O crawl fundo, que existe por um caso concreto: um site cujo contato estava
 * atrás de um menu que o crawl raso nunca alcançava.
 *
 * O raso segue no máximo `depth` links e só os que PARECEM página de contato. O
 * fundo trata isso como prioridade e não como filtro, e caminha em largura até o
 * teto de páginas — que é o que faz diferença quando o endereço está a dois
 * cliques dentro, numa página chamada `/institucional`.
 */
test("o crawl fundo acha o contato atrás de dois cliques", async () => {
  const http = stubHttp({
    "https://alfa.com.br/robots.txt": { status: 404 },
    "https://alfa.com.br": {
      body: `<html><head><title>Alfa</title></head><body>
        <a href="/institucional">Institucional</a>
        <a href="/blog/post-1">Blog</a>
      </body></html>`,
    },
    // Nada de contato aqui: só o caminho para ele. O nome não casa com
    // "contato", que é exactamente o que o raso não alcança.
    "https://alfa.com.br/institucional": {
      body: `<html><body><a href="/institucional/equipe">Nossa equipe</a></body></html>`,
    },
    "https://alfa.com.br/institucional/equipe": {
      body: `<html><body><a href="mailto:diretoria@alfa.com.br">e-mail</a>
        <a href="tel:+551133334444">tel</a></body></html>`,
    },
    "https://alfa.com.br/blog/post-1": { body: "<html><body>texto</body></html>" },
  });

  const shallow = await crawlSite("https://alfa.com.br", { http, depth: 2 });
  assert.deepEqual(shallow.emails, [], "o raso não chega lá — é o bug relatado");

  const deep = await crawlSite("https://alfa.com.br", { http, depth: 3, maxPages: 10 });
  assert.deepEqual(deep.emails, ["diretoria@alfa.com.br"]);
  assert.deepEqual(deep.phones, ["+551133334444"]);
  assert.ok(deep.pagesFetched > shallow.pagesFetched);
});

test("o crawl fundo guarda o texto das subpáginas e reordena os e-mails", async () => {
  // As duas linhas que fazem isso moravam só no ramo raso, então o crawl fundo lia
  // uma dúzia de páginas e jogava o texto fora — o scorer via só a home. E a
  // ordenação não rodava, então e-mail de terceiro achado antes ficava na frente.
  const http = stubHttp({
    "https://gama.com.br/robots.txt": { status: 404 },
    "https://gama.com.br": {
      body: `<html><head><title>Gama</title></head><body>
        <p>hey@craftpip.com</p><a href="/sobre">Sobre</a></body></html>`,
    },
    "https://gama.com.br/sobre": {
      body: `<html><body><p>palavra-so-da-subpagina</p>
        <a href="mailto:contato@gama.com.br">e-mail</a></body></html>`,
    },
  });
  const s = await crawlSite("https://gama.com.br", { http, depth: 2, maxPages: 6 });
  assert.ok(
    s.textExcerpt?.includes("palavra-so-da-subpagina"),
    "o texto da subpágina tem de chegar ao excerpt"
  );
  assert.equal(s.emails[0], "contato@gama.com.br", "o do próprio domínio vem primeiro");
});

test("o crawl fundo respeita o teto de páginas e não sai do host", async () => {
  const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">${i}</a>`).join("");
  const routes: Record<string, { status?: number; body?: string }> = {
    "https://beta.com.br/robots.txt": { status: 404 },
    "https://beta.com.br": {
      body: `<html><body>${links}<a href="https://outro.com/x">fora</a></body></html>`,
    },
  };
  for (let i = 0; i < 30; i++) {
    routes[`https://beta.com.br/p${i}`] = { body: "<html><body>nada</body></html>" };
  }
  routes["https://outro.com/x"] = {
    body: "<html><body>naoDeveriaSerLido@outro.com</body></html>",
  };

  const s = await crawlSite("https://beta.com.br", {
    http: stubHttp(routes),
    depth: 1,
    maxPages: 5,
  });
  assert.ok(s.pagesFetched <= 5, `esperava no máximo 5 páginas, li ${s.pagesFetched}`);
  // Link para outro host nunca é seguido, então o e-mail de lá não aparece.
  assert.ok(!s.emails.some((e) => e.includes("outro.com")));
});
