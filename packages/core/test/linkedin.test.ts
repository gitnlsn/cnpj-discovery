import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLinkedInTitle,
  titleLeadsWithName,
  headlineHasSubstance,
  headlineRepeatsName,
  isLinkedInBoilerplate,
  isLinkedInProfileUrl,
  linkedInIsEvidence,
} from "../src/domain/linkedin";
import { classifyHit, isStorableKind } from "../src/domain/searchNoise";
import { verifyHits } from "../src/usecases/findPresence";

/**
 * NOTE ON FIXTURES.
 *
 * These titles are constructed, not captured. Both search engines were
 * rate-limiting this IP when the module was written, and neither committed SERP
 * fixture contains a linkedin.com result — so the exact title shape is an
 * assumption. It is written down here rather than hidden: when a real result is
 * captured, that fixture supersedes these cases and any that contradict it are
 * wrong, not the parser.
 *
 * The design compensates for that uncertainty: an unrecognised title yields no
 * headline, and no headline means stored-but-not-evidence. The tests below pin
 * that direction of failure, which holds whatever the real format turns out to be.
 */

const MARIA = "MARIA RAQUEL RIBEIRO MARQUES";

// ------------------------------------------------------------------ parsing

test("the two layouts LinkedIn ships both yield a headline", () => {
  // Headline after a dash, inside the first pipe-segment.
  assert.equal(
    parseLinkedInTitle("Maria Raquel Ribeiro Marques - Professora de Matemática | LinkedIn")
      .headline,
    "Professora de Matemática"
  );
  // Headline in its own pipe-segment.
  assert.equal(
    parseLinkedInTitle("Maria Raquel Ribeiro Marques | Confeiteira | LinkedIn").headline,
    "Confeiteira"
  );
});

test("the name is the leading segment in both", () => {
  for (const t of [
    "Maria Raquel Ribeiro Marques - Professora | LinkedIn",
    "Maria Raquel Ribeiro Marques | Professora | LinkedIn",
  ]) {
    assert.equal(parseLinkedInTitle(t).leading, "Maria Raquel Ribeiro Marques");
  }
});

test("a title with only a name has no headline, and that is not an error", () => {
  const out = parseLinkedInTitle("Maria Raquel Ribeiro Marques | LinkedIn");
  assert.equal(out.leading, "Maria Raquel Ribeiro Marques");
  assert.equal(out.headline, null);
});

test("the Portuguese locale variant is chrome, not a headline", () => {
  const out = parseLinkedInTitle(
    "Maria Raquel Ribeiro Marques | Perfil profissional | LinkedIn"
  );
  assert.equal(out.headline, null, "'Perfil profissional' is furniture");
});

// Google rewrites and truncates titles, so the brand suffix cannot be required.
test("a truncated title with no brand suffix still parses", () => {
  assert.equal(
    parseLinkedInTitle("Maria Raquel Ribeiro Marques - Professora de Matemá…").headline,
    "Professora de Matemá…"
  );
});

test("en dash, em dash and middle dot all separate", () => {
  for (const sep of ["-", "–", "—", "·"]) {
    assert.equal(
      parseLinkedInTitle(`Maria Raquel Ribeiro Marques ${sep} Confeiteira | LinkedIn`).headline,
      "Confeiteira",
      sep
    );
  }
});

test("garbage and emptiness return nulls rather than throwing", () => {
  for (const t of ["", "   ", "|", "| LinkedIn", null, undefined]) {
    assert.deepEqual(parseLinkedInTitle(t), { leading: null, headline: null }, String(t));
  }
});

// -------------------------------------------------------- the identity gate

test("the name must LEAD the title, not merely appear in it", () => {
  assert.equal(
    titleLeadsWithName("Maria Raquel Ribeiro Marques - Professora | LinkedIn", MARIA),
    true
  );
  // An article that mentions her in the middle is not her profile.
  assert.equal(
    titleLeadsWithName("Como estudar para concursos - Maria Raquel Ribeiro Marques", MARIA),
    false
  );
});

/**
 * The dangerous one, and the reason this gate replaced the generic name check.
 *
 * LinkedIn prints an "Outras pessoas chamadas X" block on profile pages, and both
 * engines lift it into snippets. So a namesake list on a DIFFERENT person's
 * profile can satisfy a name match — a confident wrong answer with the
 * best-looking provenance available.
 */
test("a namesake list on someone else's profile does not pass", () => {
  const title = "João Pedro Silva - Analista | LinkedIn";
  const description = "Outras pessoas chamadas Maria Raquel Ribeiro Marques";
  assert.equal(titleLeadsWithName(title, MARIA), false);
  // And the description is where the name really was — which is exactly what
  // must not count.
  assert.match(description, /Maria Raquel Ribeiro Marques/);
});

test("decoration after the name is tolerated", () => {
  for (const suffix of [", MBA", " 🎓", " (Ela/Dela)", " - 2nd"]) {
    assert.equal(
      titleLeadsWithName(
        `Maria Raquel Ribeiro Marques${suffix} | Professora | LinkedIn`,
        MARIA
      ),
      true,
      suffix
    );
  }
});

test("a two-token name cannot pass this gate either", () => {
  assert.equal(titleLeadsWithName("Ana Souza - Professora | LinkedIn", "ANA SOUZA"), false);
});

// -------------------------------------------------------------- substance

test("a real trade has substance, however short", () => {
  for (const h of ["Confeiteira", "Professora de Matemática", "Fundadora do Cursinho Alfa"]) {
    assert.equal(headlineHasSubstance(h), true, h);
  }
});

test("generic roles do not", () => {
  for (const h of [
    "Estudante",
    "Autônomo",
    "Profissional liberal",
    "MEI",
    "CEO",
    "Freelancer",
  ]) {
    assert.equal(headlineHasSubstance(h), false, h);
  }
});

test("a location is where they are, not what they do", () => {
  for (const h of ["São Paulo, São Paulo, Brasil", "Região de Manaus", "Grande São Paulo"]) {
    assert.equal(headlineHasSubstance(h), false, h);
  }
});

test("punctuation does not rescue a generic role", () => {
  assert.equal(headlineHasSubstance("-- Estudante --"), false);
  assert.equal(headlineHasSubstance("Autônomo."), false);
});

test("empty and null have no substance", () => {
  for (const h of ["", "  ", "-", null, undefined]) {
    assert.equal(headlineHasSubstance(h), false, String(h));
  }
});

/**
 * LinkedIn's marketing copy leaks into snippets, and `renderCandidate` prints
 * the description prominently — so unrejected it would read to the model as a
 * description of the business.
 */
test("the site's own marketing copy is not a description of anybody", () => {
  assert.equal(
    isLinkedInBoilerplate(
      "Ver o perfil de Maria Raquel no LinkedIn, a maior comunidade profissional do mundo"
    ),
    true
  );
  assert.equal(isLinkedInBoilerplate("Preparatório para concursos em Manaus"), false);
});

test("a headline that just repeats the name adds nothing", () => {
  assert.equal(headlineRepeatsName("Maria Raquel Ribeiro Marques", MARIA), true);
  assert.equal(headlineRepeatsName("Professora de Matemática", MARIA), false);
});

// ------------------------------------------------------------------- URLs

test("only profiles count as LinkedIn; posts and jobs do not", () => {
  assert.equal(isLinkedInProfileUrl("https://www.linkedin.com/in/maria-raquel-123"), true);
  assert.equal(isLinkedInProfileUrl("https://br.linkedin.com/in/maria-raquel"), true);
  assert.equal(isLinkedInProfileUrl("https://linkedin.com/pub/maria-raquel/1/2/3"), true);

  for (const url of [
    "https://www.linkedin.com/posts/maria-raquel_activity-123",
    "https://www.linkedin.com/pulse/como-estudar-maria",
    "https://www.linkedin.com/jobs/view/12345",
    "https://www.linkedin.com/company/cursinho-alfa",
    "https://www.linkedin.com/feed/update/123",
    // The namesake directory: a page whose entire purpose is listing different
    // people who share a name.
    "https://www.linkedin.com/pub/dir/Maria/Silva",
  ]) {
    assert.equal(isLinkedInProfileUrl(url), false, url);
  }
});

test("classifyHit separates profiles, entity pages and everything else", () => {
  assert.equal(classifyHit("https://br.linkedin.com/in/maria"), "linkedin");
  assert.equal(classifyHit("https://www.linkedin.com/posts/maria_activity-1"), "resume");

  // This assertion used to read `"resume"`, and the change is deliberate rather
  // than a fix. An entity page's *title* carries only the company name, which we
  // already had — so while nothing could fetch the page, discarding it with the
  // posts and job ads was right. It stops being right once something reads the
  // page, where the employee band and the industry live. See
  // `isLinkedInEntityUrl` and `usecases/enrichLinkedIn`.
  assert.equal(classifyHit("https://www.linkedin.com/company/x"), "linkedin_company");
});

/**
 * The safety property. `routers/enrichment.ts` promotes stored hits with
 * `kind = 'site'` into crawl targets, and `crawlSite` would then request
 * linkedin.com — the one host this feature must never touch, because its
 * robots.txt is a blanket Disallow.
 *
 * `lnkd.in` is LinkedIn's own shortener and is the sneaky path to the same place.
 */
test("no LinkedIn URL is ever classified as a crawlable site", () => {
  for (const url of [
    "https://www.linkedin.com/in/maria",
    "https://br.linkedin.com/in/maria",
    "https://www.linkedin.com/posts/maria_activity-1",
    "https://lnkd.in/abc123",
    // Added when entity pages became storable: they are now a `kind` the
    // pipeline keeps, so the property that they are never a *crawlable site*
    // matters more than it did, not less. `crawlSite` still honours robots.txt
    // and must never be pointed at this host; the browser driver in
    // `@cnpj/serp/linkedin` is the only thing allowed to fetch it.
    "https://www.linkedin.com/company/cursinho-alfa",
    "https://br.linkedin.com/company/cursinho-alfa/about",
  ]) {
    assert.notEqual(classifyHit(url), "site", url);
  }
});

// --------------------------------------------------- storage versus evidence

const hit = (over: Partial<{ url: string; title: string; description: string }> = {}) => ({
  url: "https://br.linkedin.com/in/maria-raquel-ribeiro-marques",
  title: "Maria Raquel Ribeiro Marques - Professora de Matemática | LinkedIn",
  description: "Manaus, Amazonas, Brasil",
  ...over,
});

const COMPANY = {
  razaoSocial: MARIA,
  nomeFantasia: null,
  municipio: "MANAUS",
  uf: "AM",
};

test("a profile with a real headline is stored AND counts", () => {
  const [out] = verifyHits([hit()], COMPANY);
  assert.ok(out);
  assert.equal(out.kind, "linkedin");
  assert.equal(out.headline, "Professora de Matemática");
  assert.equal(isStorableKind(out.kind), true);
  assert.equal(linkedInIsEvidence(out, MARIA), true);
});

// The product rule: recorded so the cohort is measurable, invisible to the model.
test("a profile with no usable headline is stored but does NOT count", () => {
  const [out] = verifyHits(
    [hit({ title: "Maria Raquel Ribeiro Marques - Estudante | LinkedIn" })],
    COMPANY
  );
  assert.ok(out, "still stored");
  assert.equal(out.headline, "Estudante");
  assert.equal(linkedInIsEvidence(out, MARIA), false, "but never reaches the model");
});

/**
 * A substantive headline about an unrelated job.
 *
 * This passes every mechanical check and is evidence the person has an employer
 * rather than a business — the exact case the old RESUME exclusion was making a
 * judgement about. It reaches the model on purpose, because deciding it needs
 * reading the CNAE against the trade, and `LINKEDIN_RULES` tells the model to.
 */
test("an unrelated job title reaches the model rather than being guessed at", () => {
  const [out] = verifyHits(
    [hit({ title: "Maria Raquel Ribeiro Marques - Analista na Prefeitura | LinkedIn" })],
    COMPANY
  );
  assert.ok(out);
  assert.equal(linkedInIsEvidence(out, MARIA), true, "code does not adjudicate the trade");
});

/**
 * Two namesakes in one result page is positive proof the name identifies neither.
 * They are kept as the record of ambiguity and counted as nothing.
 */
test("several profiles leading with the same name cancel each other out", () => {
  const out = verifyHits(
    [
      hit(),
      hit({
        url: "https://br.linkedin.com/in/maria-raquel-ribeiro-marques-2",
        title: "Maria Raquel Ribeiro Marques - Advogada | LinkedIn",
      }),
    ],
    COMPANY
  );
  assert.equal(out.length, 2, "both stored — the ambiguity is the finding");
  for (const h of out) {
    assert.equal(h.ambiguous, true);
    assert.equal(linkedInIsEvidence(h, MARIA), false);
  }
});

test("boilerplate in the snippet is emptied, not passed through as a description", () => {
  const [out] = verifyHits(
    [
      hit({
        description:
          "Ver o perfil de Maria Raquel no LinkedIn, a maior comunidade profissional do mundo",
      }),
    ],
    COMPANY
  );
  assert.ok(out);
  assert.equal(out.description, "");
});
