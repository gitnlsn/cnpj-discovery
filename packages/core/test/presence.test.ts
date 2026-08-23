import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeName,
  isNameMatch,
  searchQuery,
  matchStrength,
  stripRegistryNumbers,
} from "../src/domain/nameMatch";
import { classifyHit, isUsefulKind, looksLikeRegistryMirror } from "../src/domain/searchNoise";
import {
  findPresence,
  verifyHits,
  BlockStreak,
  type PresenceProvider,
} from "../src/usecases/findPresence";
import type { SerpPage } from "../src/domain/serpParse";
import { createDdgSearch } from "../src/adapters/ddgSearch";
import type { HttpPort } from "../src/ports/index";

const MARIA = {
  razaoSocial: "MARIA RAQUEL RIBEIRO MARQUES",
  nomeFantasia: null,
  municipio: "MANAUS",
  uf: "AM",
};

// ------------------------------------------------------------ normalization

test("normalizeName drops accents, case and connectives", () => {
  assert.deepEqual(normalizeName("José da Silva Araújo"), ["JOSE", "SILVA", "ARAUJO"]);
});

// The same person is "MARIA DA SILVA" in one Receita record and "MARIA SILVA"
// in another; neither spelling may fail against the other.
test("the two spellings of a connective normalize the same", () => {
  assert.deepEqual(normalizeName("MARIA DA SILVA COSTA"), normalizeName("MARIA SILVA COSTA"));
});

test("a trailing CNPJ or sequence number is not part of the name", () => {
  assert.deepEqual(normalizeName("KAUE SILVA COSTA 68466264"), ["KAUE", "SILVA", "COSTA"]);
});

// ---------------------------------------------------------------- matching

test("a full name matches its own text", () => {
  assert.equal(isNameMatch("Perfil de Maria Raquel Ribeiro Marques", MARIA.razaoSocial), true);
});

test("accents and punctuation do not break the match", () => {
  assert.equal(isNameMatch("JOSÉ DA SILVA - Aulas", "JOSE SILVA PEREIRA"), false);
  assert.equal(isNameMatch("José, da Silva; Pereira!", "JOSE SILVA PEREIRA"), true);
});

// A two-token name has thousands of bearers per state. Matching it would
// deliver a wrong answer confidently, which is worse than no answer.
test("a name with fewer than three parts is refused, not matched loosely", () => {
  assert.equal(isNameMatch("Ana Souza faz bolos", "ANA SOUZA"), false);
  assert.equal(searchQuery({ ...MARIA, razaoSocial: "ANA SOUZA" }), null);
});

// The specific false positive that motivated requiring whole words.
test("a longer name is not matched by a shorter one inside it", () => {
  assert.equal(isNameMatch("MARIANA VALERIA PIOVESANI", "ANA VALERIA PIOVESAN"), false);
  assert.equal(isNameMatch("ANA VALERIA PIOVESAN", "ANA VALERIA PIOVESAN"), true);
});

// Contiguity: a directory page listing thirty unrelated people would otherwise
// "contain" every token of the name and match everybody on it.
test("scattered tokens on a list page do not match", () => {
  const listing = "Maria Costa, Raquel Alves, Ribeiro Santos, Marques Lima";
  assert.equal(isNameMatch(listing, MARIA.razaoSocial), false);
});

test("matchStrength finds the name in a handle when the title has nothing", () => {
  const hit = {
    url: "https://instagram.com/maria.raquel.ribeiro.marques",
    title: "Instagram",
    description: "Fotos e vídeos",
  };
  assert.deepEqual(matchStrength(hit, MARIA.razaoSocial), { matched: true, where: "url" });
});

test("searchQuery quotes the name and appends the location", () => {
  assert.equal(searchQuery(MARIA), '"MARIA RAQUEL RIBEIRO MARQUES" MANAUS AM');
});

// ------------------------------------------------------------ classification

test("classifyHit separates mirrors, socials and real sites", () => {
  assert.equal(classifyHit("https://cnpj.biz/68464469000115"), "aggregator");
  assert.equal(classifyHit("https://www.casadosdados.com.br/x"), "aggregator");
  assert.equal(classifyHit("https://jusbrasil.com.br/processos/1"), "legal");
  assert.equal(classifyHit("https://br.linkedin.com/in/maria"), "resume");
  assert.equal(classifyHit("https://instagram.com/cursinho"), "social");
  assert.equal(classifyHit("https://cursinhomaria.com.br"), "site");
  assert.equal(classifyHit("nonsense"), "unknown");
});

test("only social and site count as evidence", () => {
  assert.equal(isUsefulKind("social"), true);
  assert.equal(isUsefulKind("site"), true);
  assert.equal(isUsefulKind("aggregator"), false);
  assert.equal(isUsefulKind("legal"), false);
});

// ---------------------------------------------------------------- verifying

/**
 * The central case. A CNPJ mirror carries the razão social verbatim, so it
 * passes the name gate with the strongest possible match — and it is our own
 * data. Without the host gate the pipeline would "discover" a web presence for
 * every company in the base.
 */
test("a mirror is rejected even though its title matches the name exactly", () => {
  const hits = [
    {
      url: "https://cnpj.biz/68464469000115",
      title: "MARIA RAQUEL RIBEIRO MARQUES 68464469000115 Manaus - cnpj.biz",
      description: "Todos os dados da empresa MARIA RAQUEL RIBEIRO MARQUES.",
    },
  ];
  assert.deepEqual(verifyHits(hits, MARIA), []);
});

test("a social profile with the name survives, and keeps its description", () => {
  const hits = [
    {
      url: "https://instagram.com/mariaraquel.cursos",
      title: "Maria Raquel Ribeiro Marques (@mariaraquel.cursos)",
      description: "Preparatório para concursos em Manaus. Turmas presenciais.",
    },
  ];
  const [hit] = verifyHits(hits, MARIA);
  assert.ok(hit);
  assert.equal(hit.kind, "social");
  assert.equal(hit.matchedOn, "title");
  // The description is the payload: link hubs are never fetched, so this is the
  // only thing we will ever know about this business.
  assert.match(hit.description, /concursos em Manaus/);
});

test("a different person with a similar name is rejected", () => {
  const hits = [
    {
      url: "https://instagram.com/maria.marques",
      title: "Maria Marques Ribeiro (@maria.marques)",
      description: "Bolos caseiros",
    },
  ];
  assert.deepEqual(verifyHits(hits, MARIA), []);
});

// ------------------------------------------------------------------- chain

const provider = (name: string, pages: SerpPage[]): PresenceProvider & { calls: number } => {
  let i = 0;
  const p = {
    name,
    calls: 0,
    async search(): Promise<SerpPage> {
      p.calls++;
      return pages[Math.min(i++, pages.length - 1)]!;
    },
  };
  return p;
};

const okPage = (url: string, title: string): SerpPage => ({
  status: "ok",
  hits: [{ url, title, description: "Aulas para concursos." }],
});

test("the chain stops at the first provider that answers", async () => {
  const ddg = provider("ddg", [
    okPage("https://instagram.com/mrrm", "Maria Raquel Ribeiro Marques"),
  ]);
  const google = provider("google", [okPage("https://x.com", "x")]);

  const out = await findPresence(MARIA, [ddg, google]);
  assert.equal(out.status, "found");
  assert.equal(google.calls, 0, "google was never asked");
});

test("a blocked provider escalates to the next one", async () => {
  const ddg = provider("ddg", [{ status: "blocked", reason: "anomalia" }]);
  const google = provider("google", [
    okPage("https://instagram.com/mrrm", "Maria Raquel Ribeiro Marques"),
  ]);

  const blocked: string[] = [];
  const out = await findPresence(MARIA, [ddg, google], {
    onProviderBlocked: (i) => blocked.push(i.provider),
  });
  assert.equal(out.status, "found");
  assert.equal(google.calls, 1);
  assert.deepEqual(blocked, ["ddg"]);
});

test("changed markup escalates too — it is a failure, not an answer", async () => {
  const ddg = provider("ddg", [{ status: "unrecognized" }]);
  const google = provider("google", [
    okPage("https://instagram.com/mrrm", "Maria Raquel Ribeiro Marques"),
  ]);
  assert.equal((await findPresence(MARIA, [ddg, google])).status, "found");
  assert.equal(google.calls, 1);
});

/**
 * The rule that protects the Google quota and the IP.
 *
 * "DDG searched and found nothing" is an answer. Re-asking Google to confirm a
 * negative is how a run gets itself blocked for no information gain.
 */
test("an empty result does NOT escalate", async () => {
  const ddg = provider("ddg", [{ status: "empty" }]);
  const google = provider("google", [okPage("https://x.com", "x")]);

  const out = await findPresence(MARIA, [ddg, google]);
  assert.equal(out.status, "none");
  assert.equal(google.calls, 0, "google must not be spent confirming a negative");
});

test("results that all fail verification are 'none', not 'blocked'", async () => {
  const ddg = provider("ddg", [
    okPage("https://cnpj.biz/1", "MARIA RAQUEL RIBEIRO MARQUES - cnpj.biz"),
  ]);
  const out = await findPresence(MARIA, [ddg]);
  assert.equal(out.status, "none");
  // We did look, and we looked at something — worth recording honestly.
  assert.equal(out.status === "none" && out.considered, 1);
});

test("every provider blocked is 'blocked', never 'none'", async () => {
  const ddg = provider("ddg", [{ status: "blocked", reason: "a" }]);
  const google = provider("google", [{ status: "blocked", reason: "captcha" }]);
  const out = await findPresence(MARIA, [ddg, google]);
  assert.equal(out.status, "blocked");
});

test("a name too short to verify never spends a query", async () => {
  const ddg = provider("ddg", [okPage("https://x.com", "x")]);
  const out = await findPresence({ ...MARIA, razaoSocial: "ANA SOUZA" }, [ddg]);
  assert.equal(out.status, "unverifiable");
  assert.equal(ddg.calls, 0);
});

// ---------------------------------------------------------- circuit breaker

test("BlockStreak stops the run after consecutive blocks", () => {
  const streak = new BlockStreak(3);
  assert.equal(streak.record({ status: "blocked", reason: "x", query: "q" }), false);
  assert.equal(streak.record({ status: "unrecognized", query: "q" }), false);
  assert.equal(streak.record({ status: "blocked", reason: "x", query: "q" }), true);
});

test("a single success resets the streak", () => {
  const streak = new BlockStreak(2);
  streak.record({ status: "blocked", reason: "x", query: "q" });
  streak.record({ status: "none", query: "q", provider: "ddg", considered: 0 });
  assert.equal(streak.consecutive, 0);
  assert.equal(streak.record({ status: "blocked", reason: "x", query: "q" }), false);
});

// ------------------------------------------------------------- DDG adapter

test("createDdgSearch parses a real saved page through the port", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const body = readFileSync(join(import.meta.dirname, "fixtures", "ddg-results.html"), "utf8");

  const http: HttpPort = {
    async fetch() {
      return new Response(body, { status: 200 });
    },
  };
  const page = await createDdgSearch({ http }).search("q");
  assert.equal(page.status, "ok");
});

test("a 4xx that is not 429 throws instead of retrying forever", async () => {
  let calls = 0;
  const http: HttpPort = {
    async fetch() {
      calls++;
      return new Response("nope", { status: 403 });
    },
  };
  await assert.rejects(() => createDdgSearch({ http, retries: 2 }).search("q"), /403/);
  assert.equal(calls, 1, "403 will not improve on retry");
});

// ------------------------------------------------------ reaching the model

const SPEC_INPUT = {
  version: 1,
  summary: "s",
  buyer: "b",
  problem: "p",
  probes: [],
  rubric: {
    axes: [
      {
        key: "a",
        question: "q",
        weight: 1,
        anchors: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" },
      },
    ],
    notes: [],
    siteSignals: "full",
    recommendations: ["x"],
  },
};

test("verified presence is rendered with its description, and turns on the rules", async () => {
  const { renderCandidate } = await import("../src/usecases/scoreCompanies");
  const { buildRubricPrompt } = await import("../src/domain/prompt");
  const { parseProjectSpec } = await import("../src/domain/spec");
  const spec = parseProjectSpec(SPEC_INPUT);

  const out = renderCandidate(
    {
      cnpj: "68464469000115",
      razaoSocial: "MARIA RAQUEL RIBEIRO MARQUES",
      nomeFantasia: null,
      cnae: "8599605",
      cnaeDescricao: null,
      uf: "AM",
      municipio: "MANAUS",
      dataInicioAtividade: "2026-08-08",
      porte: null,
      mei: true,
      site: null,
      webPresence: [
        {
          url: "https://instagram.com/mariaraquel.cursos",
          title: "Maria Raquel Ribeiro Marques",
          description: "Preparatório para concursos em Manaus.",
          kind: "social",
        },
      ],
    },
    spec
  );

  assert.match(out, /presença na web \(nome confirmado, social\)/);
  assert.match(out, /instagram\.com\/mariaraquel\.cursos/);
  // The description is what establishes the line of business; the URL alone
  // only establishes that the person exists.
  assert.match(out, /descrição: Preparatório para concursos em Manaus/);

  // The rules block is added only when a run actually has presence, so a plain
  // run keeps the prompt — and therefore the promptSha — it always had.
  assert.doesNotMatch(buildRubricPrompt(spec, {}), /presença na web/);
  assert.match(buildRubricPrompt(spec, { withWebPresence: true }), /presença na web/);
});

test("a hit with no description says so, instead of implying a business", async () => {
  const { renderCandidate } = await import("../src/usecases/scoreCompanies");
  const { parseProjectSpec } = await import("../src/domain/spec");

  const out = renderCandidate(
    {
      cnpj: "1",
      razaoSocial: "X Y Z",
      nomeFantasia: null,
      cnae: "1",
      cnaeDescricao: null,
      uf: null,
      municipio: null,
      dataInicioAtividade: null,
      porte: null,
      mei: true,
      site: null,
      webPresence: [
        { url: "https://instagram.com/xyz", title: "X Y Z", description: "", kind: "social" },
      ],
    },
    parseProjectSpec(SPEC_INPUT)
  );
  assert.match(out, /só confirma a pessoa, não o ramo/);
});

// ------------------------------------------- mirrors the blocklist never saw

/**
 * Taken verbatim from a live run.
 *
 * `cadastroempresa.com.br` was not in the blocklist, classified as a real site,
 * matched the owner's name in its snippet, and was stored as this company's web
 * presence. It is a Receita mirror. The host list will always be missing the
 * next one of these, so the content signature is what has to catch them.
 */
test("a mirror on an unknown domain is caught by its own prose", () => {
  const real = {
    url: "https://cadastroempresa.com.br/fornecedor/caio-augusto-andrade-macedo",
    title: "68.395.981 CAIO AUGUSTO ANDRADE MACEDO",
    description:
      "68.395.981 Caio Augusto Andrade Macedo é uma empresa de CNPJ 68.395.981/0001-57 " +
      "com situação cadastral ativa, natureza jurídica de empresário individual.",
  };
  assert.equal(looksLikeRegistryMirror(real), true);

  const company = {
    razaoSocial: "CAIO AUGUSTO ANDRADE MACEDO",
    nomeFantasia: null,
    municipio: "SAO PAULO",
    uf: "SP",
  };
  // The whole point: this used to survive verification.
  assert.deepEqual(verifyHits([real], company), []);
});

test("a real business page is not mistaken for a mirror", () => {
  assert.equal(
    looksLikeRegistryMirror({
      title: "Cursinho Alfa — preparatório para concursos",
      description:
        "Turmas para ENEM e concursos em Manaus. Matrículas abertas, plantão de dúvidas.",
    }),
    false
  );
});

// A footer CNPJ is normal for a Brazilian company and must not disqualify it.
// One registry phrase is required alongside it before this fires.
test("a CNPJ alone does not make a page a mirror", () => {
  assert.equal(
    looksLikeRegistryMirror({
      title: "Padaria do Zé",
      description: "Pães artesanais desde 2001. CNPJ 04.837.771/0001-99. Rua das Flores, 10.",
    }),
    false
  );
});

test("two registry phrases are a mirror even with no CNPJ in the snippet", () => {
  assert.equal(
    looksLikeRegistryMirror({
      title: "Consulta de empresa",
      description: "Veja a situação cadastral e o quadro societário completo desta empresa.",
    }),
    true
  );
});

// -------------------------------------- the CNPJ the Receita staples on front

/**
 * Every MEI row in the real base looks like this.
 *
 * Not a curiosity — it broke the whole feature silently. A quoted search for
 * `"68.464.349 MICAEL ADRIANO BARBOSA DE SOUZA"` matches only CNPJ mirror
 * sites, because nothing else on the web pairs that number with that name. So
 * every result was a mirror, every mirror was correctly rejected, and the
 * feature returned nothing while looking like it was working.
 */
test("the leading CNPJ is stripped from a MEI razão social", () => {
  assert.equal(
    stripRegistryNumbers("68.464.349 MICAEL ADRIANO BARBOSA DE SOUZA"),
    "MICAEL ADRIANO BARBOSA DE SOUZA"
  );
  assert.equal(
    stripRegistryNumbers("68.394.953 GIOVANNI OLIVEIRA SILVA"),
    "GIOVANNI OLIVEIRA SILVA"
  );
  // Full CNPJ, and the bare-digit variant.
  assert.equal(stripRegistryNumbers("68.464.469/0001-15 MARIA RAQUEL"), "MARIA RAQUEL");
  assert.equal(
    stripRegistryNumbers("68464349 AILTON JOAO CAVASSOLLA"),
    "AILTON JOAO CAVASSOLLA"
  );
});

test("a name with no number is untouched", () => {
  assert.equal(stripRegistryNumbers("PADARIA DO ZE LTDA"), "PADARIA DO ZE LTDA");
});

test("digits never count as name tokens", () => {
  assert.deepEqual(normalizeName("68.464.349 MICAEL ADRIANO BARBOSA DE SOUZA"), [
    "MICAEL",
    "ADRIANO",
    "BARBOSA",
    "SOUZA",
  ]);
  // Two real names plus a CNPJ used to reach the 3-token gate on the digits
  // alone, so a name too common to verify was searched anyway.
  assert.equal(normalizeName("68.464.349 ANA SOUZA").length, 2);
  assert.equal(searchQuery({ ...MARIA, razaoSocial: "68.464.349 ANA SOUZA" }), null);
});

// This is the query that should have been sent all along.
test("the search query is the person, not the registry entry", () => {
  assert.equal(
    searchQuery({
      razaoSocial: "68.394.953 GIOVANNI OLIVEIRA SILVA",
      nomeFantasia: null,
      municipio: "SAO PAULO",
      uf: "SP",
    }),
    '"GIOVANNI OLIVEIRA SILVA" SAO PAULO SP'
  );
});

test("a real profile now matches a CNPJ-prefixed razão social", () => {
  const company = {
    razaoSocial: "68.394.953 GIOVANNI OLIVEIRA SILVA",
    nomeFantasia: null,
    municipio: "SAO PAULO",
    uf: "SP",
  };
  const hits = [
    {
      url: "https://instagram.com/giovanni.silva.aulas",
      title: "Giovanni Oliveira Silva (@giovanni.silva.aulas)",
      description: "Aulas particulares de matemática em São Paulo.",
    },
  ];
  const [hit] = verifyHits(hits, company);
  assert.ok(hit, "the profile is found now; before, the CNPJ made it impossible");
  assert.equal(hit.kind, "social");
});
