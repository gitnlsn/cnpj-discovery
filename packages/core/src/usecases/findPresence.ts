import { matchStrength, searchQuery } from "../domain/nameMatch";
import {
  classifyHit,
  isStorableKind,
  looksLikeRegistryMirror,
  type HitKind,
} from "../domain/searchNoise";
import {
  parseLinkedInTitle,
  titleLeadsWithName,
  isLinkedInBoilerplate,
  entityTitleMatchesCompany,
} from "../domain/linkedin";
import type { SearchHit, SerpPage } from "../domain/serpParse";

/**
 * Finding a company's digital presence when the Receita gave us no website.
 *
 * The shape of the problem, restated because it drives every decision here: for
 * a MEI the razão social is a person's civil name, so the search is for a person
 * and the results are mostly about other people with similar names, plus a wall
 * of CNPJ mirror sites reflecting our own database back at us.
 *
 * Which means the search is the easy half. The verification is the feature:
 *
 * 1. The full name must appear contiguously in the result (`isNameMatch`).
 * 2. The host must not be a mirror of our own data (`classifyHit`).
 * 3. What survives is evidence, and its description is the payload — for a
 *    social profile it is the *only* thing we will ever get, because the
 *    crawler short-circuits link hubs without fetching them.
 *
 * A verified name match on its own is weak: it proves a person of that name
 * exists somewhere on the web, not that they run a business. The description is
 * what closes that gap, so it is carried through rather than discarded once a
 * URL is found.
 */

export interface PresenceHit extends SearchHit {
  kind: HitKind;
  /** Which field carried the name. Recorded so a run can be audited later. */
  matchedOn: "title" | "description" | "url";
  /**
   * For a LinkedIn profile: what the person says they do.
   *
   * Carried separately from `description` because it is derived from the title
   * rather than the snippet, and because it is the only thing that makes a
   * LinkedIn hit worth anything — see `domain/linkedin.ts`.
   */
  headline?: string | null;
  /** Several profiles led with this name, so none of them identifies anybody. */
  ambiguous?: boolean;
}

export type PresenceOutcome =
  /** We looked and verified something. */
  | {
      status: "found";
      query: string;
      hits: PresenceHit[];
      provider: string;
      considered: number;
    }
  /** We looked properly and there was nothing of ours out there. */
  | { status: "none"; query: string; provider: string; considered: number }
  /** The name is too common to verify against — two tokens or fewer. */
  | { status: "unverifiable"; reason: string }
  /**
   * We could not look. NOT the same as `none`, and the caller must not record
   * it as such: this is the state that would otherwise become "this company has
   * no web presence" for every row in a blocked run.
   */
  | { status: "blocked"; reason: string; query: string }
  | { status: "unrecognized"; query: string };

export interface PresenceCompany {
  razaoSocial: string | null;
  nomeFantasia: string | null;
  municipio: string | null;
  uf: string | null;
}

/** A provider: DDG over HTTP, or Google through a browser. Same shape. */
export interface PresenceProvider {
  readonly name: string;
  search(query: string): Promise<SerpPage>;
}

/**
 * Keeps only what survives both gates.
 *
 * Exported for its own tests: this is where a wrong answer would be most
 * expensive and least visible.
 */
export function verifyHits(hits: SearchHit[], company: PresenceCompany): PresenceHit[] {
  const name = company.razaoSocial ?? company.nomeFantasia;
  const out: PresenceHit[] = [];

  for (const hit of hits) {
    const kind = classifyHit(hit.url);
    // Mirrors first: they match the name perfectly and mean nothing, so
    // checking the name before the host would waste the strongest evidence we
    // have on the least useful result.
    if (!isStorableKind(kind)) continue;

    // The content check, for the mirrors the host list has never heard of. A
    // live run found one on the first two companies it looked at, which is the
    // measure of how incomplete a domain list is always going to be.
    if (looksLikeRegistryMirror(hit)) continue;

    if (kind === "linkedin") {
      // A different identity gate, because the generic one cannot work on this
      // host: the URL slug is generated from the display name, and the snippet
      // often contains LinkedIn's own "Outras pessoas chamadas X" block — so
      // both a slug match and a snippet match can be satisfied by a page about
      // somebody else entirely. Only the leading position of the title is
      // trustworthy. See domain/linkedin.ts.
      if (!titleLeadsWithName(hit.title, name)) continue;
      const { headline } = parseLinkedInTitle(hit.title);
      out.push({
        ...hit,
        kind,
        matchedOn: "title",
        headline,
        // The site's marketing copy is not a description of anyone's business.
        description: isLinkedInBoilerplate(hit.description) ? "" : hit.description,
      });
      continue;
    }

    if (kind === "linkedin_company") {
      // A third gate, because neither of the other two fits. The generic name
      // match fails on legal-name drift — the Receita's "COMERCIO DE PAES ALFA
      // LTDA" against a page called "Padaria Alfa" — and `titleLeadsWithName`
      // is a *person* gate that demands three tokens of a civil name. See
      // `entityTitleMatchesCompany`.
      if (!entityTitleMatchesCompany(hit.title, company)) continue;
      out.push({
        ...hit,
        kind,
        matchedOn: "title",
        description: isLinkedInBoilerplate(hit.description) ? "" : hit.description,
      });
      continue;
    }

    const { matched, where } = matchStrength(hit, name);
    if (!matched || !where) continue;

    out.push({ ...hit, kind, matchedOn: where });
  }

  return dropAmbiguousProfiles(out);
}

/**
 * Two people with the same name is proof the name identifies neither.
 *
 * If one search returns several distinct LinkedIn profiles all leading with this
 * name, the name is not a key — it is a coincidence generator, which for
 * `Silva` it always was. Picking the top one would be choosing at random and
 * presenting the result as verified.
 *
 * They are still returned for storage, so the ambiguity is on record and
 * countable; what they lose is the headline, which is what would have made any
 * of them count as evidence.
 */
function dropAmbiguousProfiles(hits: PresenceHit[]): PresenceHit[] {
  const profiles = hits.filter((h) => h.kind === "linkedin");
  if (profiles.length < 2) return hits;

  return hits.map((h) =>
    h.kind === "linkedin" ? { ...h, headline: null, ambiguous: true } : h
  );
}

/**
 * One company, through an ordered chain of providers.
 *
 * The chain escalates on `blocked` and `unrecognized` — a provider that could
 * not answer should let the next one try. It does NOT escalate on `empty` or on
 * a page that parsed but produced no verified hit: those are answers, and
 * spending a Google query to re-confirm a DDG "nothing there" is what would
 * burn the IP for no gain.
 */
export async function findPresence(
  company: PresenceCompany,
  providers: PresenceProvider[],
  opts: { onProviderBlocked?: (info: { provider: string; reason: string }) => void } = {}
): Promise<PresenceOutcome> {
  if (!providers.length)
    return { status: "unverifiable", reason: "nenhum buscador configurado" };

  const query = searchQuery(company);
  if (!query) {
    // Two tokens or fewer. Deliberately not attempted rather than attempted
    // loosely — a loose match on a common name is the wrong answer delivered
    // confidently.
    return {
      status: "unverifiable",
      reason: "nome curto demais para verificar (menos de 3 partes)",
    };
  }

  let lastBlock: { reason: string } | null = null;

  for (const provider of providers) {
    // A thrown adapter error is a provider that could not answer, not a run
    // that should die. Without this, one 403 from DuckDuckGo aborted the entire
    // job and lost every company after it.
    let page: SerpPage;
    try {
      page = await provider.search(query);
    } catch (err) {
      lastBlock = { reason: `${provider.name}: ${(err as Error).message}` };
      opts.onProviderBlocked?.({ provider: provider.name, reason: lastBlock.reason });
      continue;
    }

    if (page.status === "blocked") {
      lastBlock = { reason: page.reason };
      opts.onProviderBlocked?.({ provider: provider.name, reason: page.reason });
      continue;
    }
    if (page.status === "unrecognized") {
      lastBlock = { reason: `${provider.name}: a página de resultados mudou de formato` };
      opts.onProviderBlocked?.({ provider: provider.name, reason: lastBlock.reason });
      continue;
    }
    if (page.status === "empty") {
      return { status: "none", query, provider: provider.name, considered: 0 };
    }

    const verified = verifyHits(page.hits, company);
    return verified.length
      ? {
          status: "found",
          query,
          hits: verified,
          provider: provider.name,
          considered: page.hits.length,
        }
      : { status: "none", query, provider: provider.name, considered: page.hits.length };
  }

  return {
    status: "blocked",
    reason: lastBlock?.reason ?? "todos os buscadores falharam",
    query,
  };
}

/**
 * Stops a run that is being refused.
 *
 * Without this, a blocked run walks the whole project recording nothing found,
 * which is the one outcome that actively corrupts the dataset — and it does it
 * quietly, because every row looks like a normal negative result.
 */
export class BlockStreak {
  private streak = 0;

  constructor(private readonly limit = 3) {}

  /** True when the run should stop. */
  record(outcome: PresenceOutcome): boolean {
    if (outcome.status === "blocked" || outcome.status === "unrecognized") {
      this.streak++;
      return this.streak >= this.limit;
    }
    this.streak = 0;
    return false;
  }

  get consecutive(): number {
    return this.streak;
  }
}
