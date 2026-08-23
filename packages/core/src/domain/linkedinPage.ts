import { extractText } from "./probes";

/**
 * Turning a fetched LinkedIn page into facts.
 *
 * Pure, like everything else under `domain/`: HTML in, structured facts out, no
 * network and no environment. The fetching — which needs a signed-in browser, a
 * deliberate robots override and a person on standby — lives in
 * `@cnpj/serp/linkedin`, and the split is what lets every parsing decision here
 * be tested against a captured page instead of against the live site.
 *
 * ## Why JSON-LD first and text second
 *
 * LinkedIn renders its pages from React, so the DOM is a wall of hashed class
 * names that changes without notice; scraping it by selector is the thing that
 * breaks on somebody else's deploy. But LinkedIn also emits `application/ld+json`
 * for SEO, and that block is a *contract with search engines* — it changes far
 * more slowly, and when it changes it changes to something still valid against
 * schema.org.
 *
 * So the order is: JSON-LD for anything it carries, visible text for the two
 * fields it does not (the employee band and the industry), and `null` for
 * anything neither one yielded. Never a guess and never a default — a `null`
 * employee count is honest, a `0` would be read downstream as a fact.
 *
 * ## What is deliberately not parsed
 *
 * No employee *names*, no individual people from a company's `/people` tab, no
 * connection lists. The project scores companies, and a roster of somebody's
 * staff is personal data that would arrive with no consent, no purpose in the
 * rubric and no way to correct it. The entity parser reads the company's own
 * self-description and the counts LinkedIn publishes about it, and stops there.
 */

/** How much of a page is scanned. LinkedIn ships ~1–3 MB of markup per page. */
const SCAN_CHARS = 600_000;

/** Per-field cap, matching `structured.ts` so a row cannot grow unbounded. */
const FIELD_CHARS = 600;

// ------------------------------------------------------------------- walls

/**
 * What LinkedIn is showing instead of the page we asked for.
 *
 * These are separated because they need opposite responses, and conflating them
 * is how a crawler turns a solvable interruption into a silent data loss:
 *
 * - `auth` — the sign-in wall. The session expired or never existed. A person
 *   can fix it, so this is the one worth interrupting somebody for.
 * - `checkpoint` — LinkedIn's challenge flow, which is what it shows when it has
 *   decided the session is behaving like a script. A person can clear it, but it
 *   is also the last warning before a restriction, so the driver stops the run.
 * - `gone` — the page does not exist, or the company deleted it. Nobody can fix
 *   it and there is nothing to wait for; record it and move on.
 * - `null` — a real page.
 */
export type LinkedInWall = "auth" | "checkpoint" | "gone" | null;

/** Paths LinkedIn redirects to when it wants something from the client. */
const WALL_PATHS: { re: RegExp; wall: Exclude<LinkedInWall, null> }[] = [
  { re: /^\/checkpoint\//i, wall: "checkpoint" },
  { re: /^\/authwall/i, wall: "auth" },
  { re: /^\/uas\/login/i, wall: "auth" },
  { re: /^\/login/i, wall: "auth" },
  { re: /^\/signup/i, wall: "auth" },
  { re: /\/unavailable\/?$/i, wall: "gone" },
];

/**
 * Copy that means a wall even when the URL did not change.
 *
 * LinkedIn serves the sign-in prompt in place on some routes rather than
 * redirecting, so the URL check alone misses it. Both locales, because the
 * profile is pinned to pt-BR but LinkedIn does not always honour that.
 */
const AUTH_TEXT =
  /(entre para ver|fa(ç|c)a login para ver|junte-se ao linkedin|sign in to view|join linkedin to view|to view .{0,30}profile|cadastre-se para ver)/i;

const CHECKPOINT_TEXT =
  /(verifica(ç|c)(ão|ao) de seguran(ç|c)a|security verification|confirme que (é|e) voc(ê|e)|unusual activity|atividade incomum|vamos fazer uma verifica)/i;

const GONE_TEXT =
  /(esta p(á|a)gina n(ã|a)o existe|this page doesn'?t exist|p(á|a)gina n(ã|a)o encontrada|page not found)/i;

/**
 * Reads the wall, if there is one.
 *
 * The HTTP status is checked first and trusted most: a 999 is LinkedIn's own
 * rate-limit status and a 429 is the standard one, and both mean "stop", not
 * "parse harder". The URL comes next because a redirect is unambiguous. Body
 * text is last because a real page can quote any of this copy — a company whose
 * description mentions "verificação de segurança" would otherwise read as a
 * checkpoint forever.
 */
export function detectWall(
  html: string,
  url: string,
  status: number | null = null
): LinkedInWall {
  // 999 is LinkedIn's own, non-standard refusal. Treated as a checkpoint because
  // the correct response is identical: stop the run, do not retry, tell somebody.
  if (status === 999 || status === 429) return "checkpoint";
  if (status === 404 || status === 410) return "gone";
  if (status === 403) return "auth";

  try {
    const path = new URL(url).pathname;
    for (const { re, wall } of WALL_PATHS) if (re.test(path)) return wall;
  } catch {
    // An unparseable URL is not itself a wall; fall through to the body.
  }

  const text = extractText(html.slice(0, SCAN_CHARS), 20_000);
  if (CHECKPOINT_TEXT.test(text)) return "checkpoint";
  if (GONE_TEXT.test(text)) return "gone";
  // Last, and only on a page carrying no substance of its own: the sign-in
  // prompt appears in the footer of plenty of perfectly good pages.
  if (AUTH_TEXT.test(text) && text.length < 4_000) return "auth";
  return null;
}

// ------------------------------------------------------------------ JSON-LD

function clean(v: unknown, cap = FIELD_CHARS): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, cap) : null;
}

/** Every JSON-LD node on the page, flattened out of `@graph` and arrays. */
function jsonLdNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const blocks = html
    .slice(0, SCAN_CHARS)
    .matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  const push = (v: unknown, depth: number): void => {
    if (!v || depth > 6 || out.length > 200) return;
    if (Array.isArray(v)) {
      for (const item of v) push(item, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const node = v as Record<string, unknown>;
    out.push(node);
    if (node["@graph"]) push(node["@graph"], depth + 1);
  };

  for (const block of blocks) {
    const body = block[1]?.trim();
    if (!body || body.length > 200_000) continue;
    try {
      push(JSON.parse(body), 0);
    } catch {
      continue;
    }
  }
  return out;
}

const typeOf = (n: Record<string, unknown>): string => {
  const t = n["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  return "";
};

/** Flattens schema.org's habit of nesting a value behind `{"@value": …}`. */
function scalar(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("@value" in o) return o["@value"];
    if ("value" in o) return o.value;
    if ("name" in o) return o.name;
  }
  return v;
}

// ------------------------------------------------------------------ entities

export interface EmployeeRange {
  /** Inclusive lower bound. */
  min: number;
  /** Inclusive upper bound, or null for an open-ended top band ("10.001+"). */
  max: number | null;
}

export interface LinkedInEntityFacts {
  name: string | null;
  description: string | null;
  /** The company's own industry label, as LinkedIn's taxonomy words it. */
  industry: string | null;
  /**
   * The band the company selected when it created the page.
   *
   * Self-declared and rarely updated, which is exactly why it is kept apart
   * from `employeesOnLinkedIn`: one is a claim, the other is a count. A company
   * that declared "2-10" in 2019 and now has 300 profiles pointing at it is a
   * meaningful discrepancy, and merging the two fields would erase it.
   */
  employeeRange: EmployeeRange | null;
  /** How many LinkedIn members list this company as their employer. */
  employeesOnLinkedIn: number | null;
  headquarters: string | null;
  /** The site the company itself links to — better evidence than a guessed domain. */
  website: string | null;
  founded: string | null;
  followers: number | null;
}

const EMPTY_ENTITY: LinkedInEntityFacts = {
  name: null,
  description: null,
  industry: null,
  employeeRange: null,
  employeesOnLinkedIn: null,
  headquarters: null,
  website: null,
  founded: null,
  followers: null,
};

/**
 * A number as LinkedIn writes it in either locale.
 *
 * pt-BR uses `.` for thousands, en-US uses `,`. Both are stripped rather than
 * interpreted, because neither locale uses a decimal separator in a headcount
 * and treating "1.001" as one-point-oh-oh-one would turn a thousand employees
 * into one.
 */
function count(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // `\s` already covers the non-breaking and narrow-no-break spaces LinkedIn
  // puts inside numbers, so they need no separate class of their own.
  const digits = raw.replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * The employee band out of visible text.
 *
 * Three shapes, all observed on LinkedIn in one locale or the other:
 * "11-50 funcionários", "10.001+ funcionários", "Mais de 10.000 funcionários".
 * The dash may be a hyphen or an en dash, because LinkedIn uses both.
 */
const BAND_RANGE =
  /([\d.,]+)\s*[-–]\s*([\d.,]+)\s*(?:funcion(?:á|a)rios|employees|colaboradores)/i;
const BAND_OPEN = /([\d.,]+)\s*\+\s*(?:funcion(?:á|a)rios|employees|colaboradores)/i;
const BAND_ABOVE =
  /(?:mais de|acima de|over|more than)\s*([\d.,]+)\s*(?:funcion(?:á|a)rios|employees|colaboradores)/i;

export function parseEmployeeRange(text: string): EmployeeRange | null {
  const range = BAND_RANGE.exec(text);
  if (range) {
    const min = count(range[1]);
    const max = count(range[2]);
    // A band whose top is below its bottom is a mis-parse, not a company.
    if (min !== null && max !== null && max >= min) return { min, max };
  }
  const open = BAND_OPEN.exec(text) ?? BAND_ABOVE.exec(text);
  if (open) {
    const min = count(open[1]);
    if (min !== null) return { min, max: null };
  }
  return null;
}

/** "1.234 funcionários no LinkedIn" — a count of profiles, not a declared band. */
const ON_LINKEDIN =
  /([\d.,]+)\s*(?:funcion(?:á|a)rios|employees|associados)\s*(?:no|on|at)\s*linkedin/i;

/** "12.345 seguidores" / "12,345 followers". */
const FOLLOWERS = /([\d.,]+)\s*(?:seguidores|followers)/i;

/** The `/about` panel labels, in both locales. */
/**
 * Narrowed to the four string-valued fields on purpose.
 *
 * `keyof LinkedInEntityFacts` would compile only behind a cast, and the cast
 * would happily let a regex write a string into `employeeRange`. Naming the four
 * keys makes the assignment below type-safe with no escape hatch.
 */
const LABELLED: { field: "website" | "industry" | "headquarters" | "founded"; re: RegExp }[] = [
  { field: "website", re: /(?:site|website|site da empresa)\s*[:\n]?\s*(https?:\/\/\S+)/i },
  {
    field: "industry",
    re: /(?:setor|ind(?:ú|u)stria|industry)\s*[:\n]?\s*([^\n|·]{2,60}?)(?:\s{2,}|$|\||·)/i,
  },
  {
    field: "headquarters",
    re: /(?:sede|headquarters|localiza(?:ç|c)(?:ã|a)o da sede)\s*[:\n]?\s*([^\n|·]{2,80}?)(?:\s{2,}|$|\||·)/i,
  },
  {
    field: "founded",
    re: /(?:fundada em|fundado em|founded)\s*[:\n]?\s*(\d{4})/i,
  },
];

/**
 * Parses an entity page — `/company/`, `/school/` or `/showcase/`.
 *
 * Every field independently optional. LinkedIn pages are wildly uneven: a
 * well-tended corporate page fills all of this in and a two-person MEI page has
 * a name and nothing else, and both are legitimate outcomes that must not look
 * like a parse failure. The caller distinguishes them by `name === null`, which
 * is the one field every real entity page has.
 */
export function parseEntityAbout(html: string): LinkedInEntityFacts {
  const facts: LinkedInEntityFacts = { ...EMPTY_ENTITY };
  const nodes = jsonLdNodes(html);

  const org = nodes.find((n) =>
    /^(Organization|Corporation|EducationalOrganization|School)$/i.test(typeOf(n))
  );
  if (org) {
    facts.name = clean(scalar(org.name));
    facts.description = clean(scalar(org.description));
    facts.website = clean(scalar(org.url), 300);
    facts.founded = clean(scalar(org.foundingDate), 40);

    // `numberOfEmployees` arrives as a bare number, as a QuantitativeValue with
    // `value`, or as one with `minValue`/`maxValue`. All three are real.
    const emp = org.numberOfEmployees;
    if (emp && typeof emp === "object" && !Array.isArray(emp)) {
      const q = emp as Record<string, unknown>;
      const min = count(clean(scalar(q.minValue)));
      const max = count(clean(scalar(q.maxValue)));
      const exact = count(clean(scalar(q.value)));
      if (min !== null) facts.employeeRange = { min, max: max ?? null };
      else if (exact !== null) facts.employeesOnLinkedIn = exact;
    } else {
      const exact = count(clean(scalar(emp)));
      if (exact !== null) facts.employeesOnLinkedIn = exact;
    }

    const addr = org.address;
    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry]
        .map((v) => clean(scalar(v), 120))
        .filter(Boolean);
      if (parts.length) facts.headquarters = parts.join(", ").slice(0, FIELD_CHARS);
    } else {
      facts.headquarters = clean(scalar(addr), 200);
    }
  }

  // Visible text for the fields JSON-LD does not carry, and as a fallback for
  // the ones it sometimes omits. Never overwrites a JSON-LD value: the
  // structured block is the one LinkedIn maintains on purpose.
  const text = extractText(html.slice(0, SCAN_CHARS), 20_000);

  facts.employeeRange ??= parseEmployeeRange(text);
  facts.employeesOnLinkedIn ??= count(ON_LINKEDIN.exec(text)?.[1]);
  facts.followers ??= count(FOLLOWERS.exec(text)?.[1]);

  for (const { field, re } of LABELLED) {
    if (facts[field] != null) continue;
    const m = re.exec(text);
    const value = clean(m?.[1], field === "website" ? 300 : 120);
    if (value) facts[field] = value;
  }

  return facts;
}

// ------------------------------------------------------------------ profiles

export interface LinkedInProfileFacts {
  name: string | null;
  /** What the person says they do. The reason this host is worth reading at all. */
  headline: string | null;
  location: string | null;
  /** The person's own "about" section, when they wrote one. */
  about: string | null;
}

/**
 * Parses a person's profile page.
 *
 * Deliberately four fields and no experience history. The pipeline's question
 * about a MEI is "does this person run the business the Receita says they do",
 * and the headline answers it; a full employment history would be a dossier on
 * an individual, collected without their knowledge, to answer a question that
 * was already answered. `domain/linkedin.ts` decides whether the headline counts
 * as evidence — this only reads it.
 */
export function parseProfile(html: string): LinkedInProfileFacts {
  const facts: LinkedInProfileFacts = {
    name: null,
    headline: null,
    location: null,
    about: null,
  };

  const nodes = jsonLdNodes(html);
  const person = nodes.find((n) => /^Person$/i.test(typeOf(n)));
  if (person) {
    facts.name = clean(scalar(person.name), 200);
    // LinkedIn puts the headline in `jobTitle` on some renders and
    // `description` on others, and `disambiguatingDescription` on a third.
    facts.headline =
      clean(scalar(person.jobTitle), 300) ??
      clean(scalar(person.disambiguatingDescription), 300) ??
      clean(scalar(person.description), 300);

    const addr = person.address;
    if (addr && typeof addr === "object" && !Array.isArray(addr)) {
      const a = addr as Record<string, unknown>;
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
        .map((v) => clean(scalar(v), 80))
        .filter(Boolean);
      if (parts.length) facts.location = parts.join(", ");
    } else {
      facts.location = clean(scalar(addr), 200);
    }
  }

  // The `<title>` is the same shape the SERP shows, so the existing title parser
  // in `domain/linkedin.ts` can read it — but that is the caller's job, not
  // this function's. Here it is only a fallback for a missing JSON-LD name.
  if (!facts.name) {
    const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html.slice(0, 20_000))?.[1];
    facts.name = clean(title, 200);
  }

  return facts;
}

// ------------------------------------------------------------------- results

/**
 * The outcome of trying to read one page.
 *
 * Defined here rather than in the driver that produces it, because the
 * orchestration in `usecases/enrichLinkedIn` has to name this type and must not
 * depend on Puppeteer to do so. That is what makes the enrichment loop testable
 * against a stub instead of against linkedin.com.
 *
 * Three outcomes, deliberately not two. "We read it", "it is not there" and "we
 * were stopped" need three different rows in the database, and collapsing the
 * last two is precisely the bug `findPresence` guards against on the search
 * path: a refusal recorded as an absence becomes "this company has no LinkedIn"
 * forever.
 */
export type LinkedInPageResult =
  | { status: "ok"; url: string; mode: "entity"; facts: LinkedInEntityFacts }
  | { status: "ok"; url: string; mode: "profile"; facts: LinkedInProfileFacts }
  | { status: "gone"; url: string }
  | { status: "blocked"; url: string; wall: Exclude<LinkedInWall, null>; reason: string };
