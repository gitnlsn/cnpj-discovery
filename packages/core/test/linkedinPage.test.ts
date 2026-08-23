import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectWall,
  parseEntityAbout,
  parseProfile,
  parseEmployeeRange,
} from "../src/domain/linkedinPage";
import {
  isLinkedInEntityUrl,
  linkedInEntitySlug,
  linkedInAboutUrl,
  companyNameTokens,
  entityTitleMatchesCompany,
} from "../src/domain/linkedin";
import { classifyHit, isStorableKind } from "../src/domain/searchNoise";
import {
  planFetch,
  orderPlans,
  enrichLinkedIn,
  hasSubstance,
} from "../src/usecases/enrichLinkedIn";
import type { LinkedInPageResult } from "../src/domain/linkedinPage";

/**
 * NOTE ON FIXTURES.
 *
 * Constructed, not captured — the same caveat `linkedin.test.ts` records, and for
 * the same reason: nothing here has been run against a signed-in session, so the
 * exact markup LinkedIn serves is an assumption. What IS pinned down is the
 * JSON-LD, because that block is schema.org rather than LinkedIn's own DOM, and
 * the shapes below (`numberOfEmployees` as a bare number, as `{value}`, and as
 * `{minValue,maxValue}`) are all valid schema.org that any of its renders may
 * emit.
 *
 * When a real page is captured, that fixture supersedes these and any case that
 * contradicts it is wrong — the parser is not.
 */

// ---------------------------------------------------------------- URL shapes

test("entity URLs are recognised, documents about entities are not", () => {
  assert.ok(isLinkedInEntityUrl("https://www.linkedin.com/company/padaria-alfa"));
  assert.ok(isLinkedInEntityUrl("https://br.linkedin.com/company/padaria-alfa/about"));
  assert.ok(isLinkedInEntityUrl("https://www.linkedin.com/school/uea/"));
  assert.ok(isLinkedInEntityUrl("https://www.linkedin.com/showcase/alfa-cloud/"));

  // Somebody else's document about the company, not the company's page.
  assert.ok(!isLinkedInEntityUrl("https://www.linkedin.com/company/padaria-alfa/jobs"));
  assert.ok(!isLinkedInEntityUrl("https://www.linkedin.com/jobs/view/12345"));
  assert.ok(!isLinkedInEntityUrl("https://www.linkedin.com/posts/alfa_activity-123"));
  assert.ok(!isLinkedInEntityUrl("https://www.linkedin.com/in/maria-silva"));
  // LinkedIn's placeholder for a page it will not show.
  assert.ok(!isLinkedInEntityUrl("https://www.linkedin.com/company/unavailable"));
});

test("the about URL is canonical, dropping locale host and tracking params", () => {
  assert.equal(
    linkedInAboutUrl("https://br.linkedin.com/company/padaria-alfa?trk=public_profile"),
    "https://www.linkedin.com/company/padaria-alfa/about/"
  );
  assert.equal(
    linkedInEntitySlug("https://br.linkedin.com/company/padaria-alfa/about"),
    "padaria-alfa"
  );
  assert.equal(linkedInAboutUrl("https://www.linkedin.com/in/maria-silva"), null);
});

test("entity pages now classify as storable rather than being discarded as resumes", () => {
  const kind = classifyHit("https://br.linkedin.com/company/padaria-alfa");
  assert.equal(kind, "linkedin_company");
  assert.ok(isStorableKind(kind));

  // The narrowing that was already there must survive: a job ad is still noise.
  assert.equal(classifyHit("https://www.linkedin.com/jobs/view/12345"), "resume");
});

// ------------------------------------------------------------ identity gate

test("the legal form is stripped from the end only", () => {
  assert.deepEqual(companyNameTokens("COMERCIO DE PAES ALFA LTDA"), [
    "COMERCIO",
    "PAES",
    "ALFA",
  ]);
  assert.deepEqual(companyNameTokens("ALFA ME"), ["ALFA"]);
  // A middle token that happens to spell a legal form is not a suffix.
  assert.deepEqual(companyNameTokens("GRUPO SA CONSULTORIA"), ["GRUPO", "SA", "CONSULTORIA"]);
});

test("legal-name drift matches in both directions", () => {
  const company = { razaoSocial: "ALFA CONSULTORIA EMPRESARIAL LTDA", nomeFantasia: null };
  // LinkedIn shortens: page name is a prefix of ours.
  assert.ok(entityTitleMatchesCompany("Alfa Consultoria | LinkedIn", company));
  // And the other way: ours is a prefix of the page name.
  assert.ok(
    entityTitleMatchesCompany(
      "Alfa Consultoria Empresarial Ltda - Consultoria | LinkedIn",
      company
    )
  );
});

test("the nome fantasia matches when the razão social cannot", () => {
  assert.ok(
    entityTitleMatchesCompany("Padaria Alfa | LinkedIn", {
      razaoSocial: "COMERCIO DE PAES E DOCES XYZ LTDA",
      nomeFantasia: "PADARIA ALFA",
    })
  );
});

test("one generic token is refused", () => {
  // "Padaria" alone identifies nothing, so it must not gate through even though
  // it is a genuine prefix of the razão social.
  assert.ok(
    !entityTitleMatchesCompany("Padaria | LinkedIn", {
      razaoSocial: "PADARIA ALFA LTDA",
      nomeFantasia: null,
    })
  );
});

test("a different company is refused", () => {
  assert.ok(
    !entityTitleMatchesCompany("Padaria Beta | LinkedIn", {
      razaoSocial: "PADARIA ALFA LTDA",
      nomeFantasia: null,
    })
  );
});

// -------------------------------------------------------------------- walls

test("LinkedIn's own 999 is a checkpoint, not a mystery", () => {
  assert.equal(
    detectWall("", "https://www.linkedin.com/company/alfa/about/", 999),
    "checkpoint"
  );
  assert.equal(
    detectWall("", "https://www.linkedin.com/company/alfa/about/", 429),
    "checkpoint"
  );
});

test("a redirect to the auth wall is read from the URL", () => {
  assert.equal(detectWall("<html></html>", "https://www.linkedin.com/authwall?x=1"), "auth");
  assert.equal(
    detectWall("<html></html>", "https://www.linkedin.com/checkpoint/challenge/"),
    "checkpoint"
  );
});

test("a real page whose text merely mentions signing in is not a wall", () => {
  // The sign-in prompt sits in the footer of plenty of good pages, which is why
  // the text check requires the page to carry no substance of its own.
  const page =
    "<html><body>" +
    "<h1>Padaria Alfa</h1>" +
    "<p>Entre para ver o perfil completo</p>" +
    "x".repeat(6000) +
    "</body></html>";
  assert.equal(detectWall(page, "https://www.linkedin.com/company/alfa/about/"), null);
});

test("a thin page that is only a sign-in prompt is a wall", () => {
  const page = "<html><body><p>Junte-se ao LinkedIn para ver o perfil</p></body></html>";
  assert.equal(detectWall(page, "https://www.linkedin.com/company/alfa/about/"), "auth");
});

// ------------------------------------------------------------ employee bands

test("bands parse in both locales and both dash characters", () => {
  assert.deepEqual(parseEmployeeRange("11-50 funcionários"), { min: 11, max: 50 });
  assert.deepEqual(parseEmployeeRange("51–200 employees"), { min: 51, max: 200 });
  // Thousands separators differ by locale and neither is a decimal point.
  assert.deepEqual(parseEmployeeRange("1.001-5.000 funcionários"), { min: 1001, max: 5000 });
  assert.deepEqual(parseEmployeeRange("1,001-5,000 employees"), { min: 1001, max: 5000 });
});

test("an open-ended top band has no maximum rather than a fake one", () => {
  assert.deepEqual(parseEmployeeRange("10.001+ funcionários"), { min: 10001, max: null });
  assert.deepEqual(parseEmployeeRange("Mais de 10.000 funcionários"), {
    min: 10000,
    max: null,
  });
});

test("nonsense yields null, never a zero", () => {
  assert.equal(parseEmployeeRange("funcionários"), null);
  // A band whose top is below its bottom is a mis-parse.
  assert.equal(parseEmployeeRange("50-11 funcionários"), null);
});

// ------------------------------------------------------------ entity parsing

const ENTITY_LD = (extra: string) => `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization",
 "name":"Padaria Alfa","description":"Pães artesanais em Manaus.",
 "url":"https://padariaalfa.com.br","foundingDate":"2019",
 "address":{"@type":"PostalAddress","addressLocality":"Manaus","addressRegion":"AM","addressCountry":"BR"}
 ${extra}}
</script></head><body>11-50 funcionários · 342 seguidores</body></html>`;

test("JSON-LD carries the fields it has", () => {
  const f = parseEntityAbout(ENTITY_LD(""));
  assert.equal(f.name, "Padaria Alfa");
  assert.equal(f.description, "Pães artesanais em Manaus.");
  assert.equal(f.website, "https://padariaalfa.com.br");
  assert.equal(f.founded, "2019");
  assert.equal(f.headquarters, "Manaus, AM, BR");
});

test("visible text fills the band and follower count JSON-LD omits", () => {
  const f = parseEntityAbout(ENTITY_LD(""));
  assert.deepEqual(f.employeeRange, { min: 11, max: 50 });
  assert.equal(f.followers, 342);
});

test("numberOfEmployees is read in all three shapes schema.org allows", () => {
  const range = parseEntityAbout(
    ENTITY_LD(`,"numberOfEmployees":{"@type":"QuantitativeValue","minValue":51,"maxValue":200}`)
  );
  assert.deepEqual(range.employeeRange, { min: 51, max: 200 });

  const exact = parseEntityAbout(
    ENTITY_LD(`,"numberOfEmployees":{"@type":"QuantitativeValue","value":137}`)
  );
  assert.equal(exact.employeesOnLinkedIn, 137);

  const bare = parseEntityAbout(ENTITY_LD(`,"numberOfEmployees":137`));
  assert.equal(bare.employeesOnLinkedIn, 137);
});

test("the declared band and the member count stay separate facts", () => {
  const html = ENTITY_LD(
    `,"numberOfEmployees":{"@type":"QuantitativeValue","minValue":2,"maxValue":10}`
  ).replace("11-50 funcionários", "2-10 funcionários · 300 funcionários no LinkedIn");
  const f = parseEntityAbout(html);
  // The company says 2-10; 300 members point at it. Merging these would erase
  // exactly the discrepancy that makes the pair worth having.
  assert.deepEqual(f.employeeRange, { min: 2, max: 10 });
  assert.equal(f.employeesOnLinkedIn, 300);
});

test("a page with no JSON-LD at all yields nulls, not throws", () => {
  const f = parseEntityAbout("<html><body>nada aqui</body></html>");
  assert.equal(f.name, null);
  assert.equal(f.employeeRange, null);
  assert.equal(f.employeesOnLinkedIn, null);
});

test("malformed JSON-LD is skipped rather than fatal", () => {
  const html = `<html><head><script type="application/ld+json">{not json</script></head><body>11-50 funcionários</body></html>`;
  const f = parseEntityAbout(html);
  assert.equal(f.name, null);
  // The text fallback still works, which is the point of having one.
  assert.deepEqual(f.employeeRange, { min: 11, max: 50 });
});

// ----------------------------------------------------------- profile parsing

test("a profile's headline is read from whichever field carries it", () => {
  const mk = (field: string) =>
    `<html><head><script type="application/ld+json">
     {"@type":"Person","name":"Maria Silva","${field}":"Confeiteira | Fundadora da Doces da Maria"}
     </script></head><body></body></html>`;

  for (const field of ["jobTitle", "description", "disambiguatingDescription"]) {
    const f = parseProfile(mk(field));
    assert.equal(f.name, "Maria Silva", field);
    assert.equal(f.headline, "Confeiteira | Fundadora da Doces da Maria", field);
  }
});

test("the title is the fallback when there is no JSON-LD name", () => {
  const f = parseProfile(
    "<html><head><title>Maria Silva - Confeiteira | LinkedIn</title></head></html>"
  );
  assert.equal(f.name, "Maria Silva - Confeiteira | LinkedIn");
});

// ------------------------------------------------------------- planning work

const ROW = {
  cnpj: "11111111000111",
  url: "https://br.linkedin.com/company/padaria-alfa?trk=x",
  kind: "linkedin_company",
  title: "Padaria Alfa | LinkedIn",
  razaoSocial: "PADARIA ALFA LTDA",
  nomeFantasia: null,
};

test("a verified entity hit becomes a canonical about-page plan", () => {
  assert.deepEqual(planFetch(ROW), {
    cnpj: "11111111000111",
    url: "https://www.linkedin.com/company/padaria-alfa/about/",
    mode: "entity",
  });
});

test("the identity gate is re-applied to the stored row", () => {
  // A row stored before the gate existed, or by a looser version of it, must not
  // be fetched now just because it is on disk.
  assert.equal(planFetch({ ...ROW, title: "Padaria Beta | LinkedIn" }), null);
});

test("a profile row needs the person's name to lead the title", () => {
  const base = {
    cnpj: "2",
    url: "https://br.linkedin.com/in/maria-raquel-silva",
    kind: "linkedin",
    nomeFantasia: null,
  };
  assert.deepEqual(
    planFetch({
      ...base,
      title: "Maria Raquel Silva - Confeiteira | LinkedIn",
      razaoSocial: "MARIA RAQUEL SILVA",
    }),
    { cnpj: "2", url: "https://br.linkedin.com/in/maria-raquel-silva", mode: "profile" }
  );
  // The name in the middle is the shape `domain/linkedin.ts` refuses to trust.
  assert.equal(
    planFetch({
      ...base,
      title: "Outras pessoas chamadas Maria Raquel Silva",
      razaoSocial: "MARIA RAQUEL SILVA",
    }),
    null
  );
});

test("an ordinary website row is not LinkedIn work", () => {
  assert.equal(planFetch({ ...ROW, kind: "site", url: "https://padariaalfa.com.br" }), null);
});

test("entity pages are fetched before profiles", () => {
  const plans = [
    { cnpj: "b", url: "u1", mode: "profile" as const },
    { cnpj: "a", url: "u2", mode: "entity" as const },
  ];
  // Not cosmetic: a profile view is visible to the person viewed, so a run that
  // gets cut short should have spent its budget on the half nobody sees.
  assert.deepEqual(
    orderPlans(plans).map((p) => p.mode),
    ["entity", "profile"]
  );
});

// -------------------------------------------------------------- the stop rules

/** The entity arm specifically, so `.facts` narrows without a cast in tests. */
type OkEntity = Extract<LinkedInPageResult, { mode: "entity" }>;

const okEntity = (url: string): OkEntity => ({
  status: "ok",
  url,
  mode: "entity",
  facts: {
    name: "Alfa",
    description: "Pães",
    industry: null,
    employeeRange: { min: 11, max: 50 },
    employeesOnLinkedIn: null,
    headquarters: null,
    website: null,
    founded: null,
    followers: null,
  },
});

function stubFetcher(results: LinkedInPageResult[]) {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    stopped: null as string | null,
    async fetch(url: string) {
      calls.push(url);
      const r = results[i++] ?? okEntity(url);
      if (r.status === "blocked" && r.wall === "checkpoint") this.stopped = r.reason;
      return r;
    },
  };
}

const collectStore = () => {
  const saved: { cnpj: string; status: string }[] = [];
  return {
    saved,
    save: async (cnpj: string, r: LinkedInPageResult) =>
      void saved.push({ cnpj, status: r.status }),
  };
};

test("a checkpoint ends the run and everything after it is left unfetched", async () => {
  const plans = [1, 2, 3].map((n) => ({
    cnpj: `c${n}`,
    url: `u${n}`,
    mode: "entity" as const,
  }));
  const fetcher = stubFetcher([
    okEntity("u1"),
    { status: "blocked", url: "u2", wall: "checkpoint", reason: "verificação" },
  ]);
  const store = collectStore();

  const stats = await enrichLinkedIn(plans, fetcher, store, { budget: 10 });

  assert.equal(fetcher.calls.length, 2, "must not fetch past the checkpoint");
  assert.equal(stats.stoppedBecause, "checkpoint");
  assert.equal(stats.blocked, 1);
  // The refusal is on record. A missing row would later read as "nobody looked",
  // and a clean row would read as "LinkedIn has nothing" — both are false.
  assert.deepEqual(
    store.saved.map((s) => s.status),
    ["ok", "blocked"]
  );
});

test("a missing page does not stop the run", async () => {
  const plans = [1, 2].map((n) => ({ cnpj: `c${n}`, url: `u${n}`, mode: "entity" as const }));
  const fetcher = stubFetcher([{ status: "gone", url: "u1" }, okEntity("u2")]);

  const stats = await enrichLinkedIn(plans, fetcher, collectStore(), { budget: 10 });

  assert.equal(fetcher.calls.length, 2, "a 404 says nothing about the next page");
  assert.equal(stats.gone, 1);
  assert.equal(stats.fetched, 1);
  assert.equal(stats.stoppedBecause, null);
});

test("the budget is a ceiling and the overflow is reported, not silently dropped", async () => {
  const plans = [1, 2, 3, 4].map((n) => ({
    cnpj: `c${n}`,
    url: `u${n}`,
    mode: "entity" as const,
  }));
  const fetcher = stubFetcher([]);

  const stats = await enrichLinkedIn(plans, fetcher, collectStore(), { budget: 2 });

  assert.equal(fetcher.calls.length, 2);
  assert.equal(stats.stoppedBecause, "budget");
});

test("cancelling stops before the next fetch, not after it", async () => {
  const plans = [1, 2].map((n) => ({ cnpj: `c${n}`, url: `u${n}`, mode: "entity" as const }));
  const fetcher = stubFetcher([]);
  let calls = 0;

  const stats = await enrichLinkedIn(plans, fetcher, collectStore(), {
    budget: 10,
    cancelled: () => calls++ > 0,
  });

  assert.equal(fetcher.calls.length, 1);
  assert.equal(stats.stoppedBecause, "cancelled");
});

test("a page carrying only its own name is not an improvement", () => {
  // The name came from our own search, so a page with nothing else is our query
  // reflected back — the same trap `looksLikeRegistryMirror` guards on the SERP.
  const bare = okEntity("u");
  assert.ok(hasSubstance(bare));
  const nameOnly: LinkedInPageResult = {
    ...bare,
    facts: { ...bare.facts, description: null, employeeRange: null },
  };
  assert.ok(!hasSubstance(nameOnly));
  assert.ok(!hasSubstance({ status: "gone", url: "u" }));
});
