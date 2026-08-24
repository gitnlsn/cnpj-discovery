import "server-only";
import {
  apexOf,
  classifyHit,
  cnpjsFromHit,
  discoveryQuery,
  isNonBusinessHost,
  isNonResult,
  looksLikeRegistryMirror,
  PLACES_MAX_RESULTS,
  type PresenceProvider,
} from "@cnpj/core";
import type { Db } from "@cnpj/db";
import { placesFor } from "../lib/places";
import { serpFor } from "../lib/serp";

/**
 * Where candidate businesses come from, behind one interface.
 *
 * Three engines, and they are NOT interchangeable — the difference decides how
 * many of the leads can be matched back to a CNPJ at all:
 *
 * - **places** returns a structured business: website, name AND street address.
 *   The address is what the strongest dedup route needs, so this is the only
 *   engine whose leads can be matched by where they are.
 * - **google** and **duckduckgo** return a web page: a URL, a title and a
 *   snippet. There is no address, so those leads fall through to the weaker
 *   routes (a host we already crawled, or the registered e-mail domain) and will
 *   mostly come back as "não achamos o CNPJ". That is an honest outcome, not a
 *   bug — but it is why Places is the default.
 *
 * What organic search gives back in exchange is the registry mirrors. A
 * `cnpj.biz` page in the results carries the CNPJ in its own snippet, which is
 * free evidence Places never provides. Those are collected here as `cnpjHints`.
 */
export type DiscoveryEngine = "places" | "google" | "duckduckgo";

/** One candidate business, however it was found. */
export interface Candidate {
  websiteUrl: string;
  apex: string;
  /** What the engine called it. Transient — never written to a column. */
  name: string | null;
  /** Places only. Organic engines have no address to give. */
  address: string | null;
  /** Places only. The one Google-derived value the terms let us keep. */
  placeId: string | null;
}

/**
 * Why results were dropped, counted.
 *
 * Exists because "10 vistos · 2 novos" is unfalsifiable on its own: it looks
 * identical whether the gates are working or silently eating everything. A filter
 * you cannot inspect is indistinguishable from a hole in the data, which is the
 * argument the `cnaeYield` column already makes on the other tab.
 *
 * Note what this is NOT: none of these are dedup against the Receita. That
 * happens later, and its answer is the verdict. A result dropped here never got
 * far enough to be compared with anything.
 */
export interface DropTally {
  /** Registry mirrors and aggregators. Diverted to `cnpjHints`, not wasted. */
  mirror: number;
  /** Instagram, Facebook, LinkedIn — the crawler cannot read a link hub. */
  social: number;
  /** Marketplaces, news, Wikipedia, class portals. Never the business itself. */
  nonBusiness: number;
  /** Court records, PDFs, gov.br, job boards. */
  document: number;
  /** Search-engine chrome, or an unparseable URL. */
  nonResult: number;
  /** Already found — by an earlier query in this sweep, or an earlier sweep. */
  alreadySeen: number;
}

export interface FetchResult {
  candidates: Candidate[];
  /** Raw results the engine returned, before any filtering. */
  considered: number;
  /** Where the rest went. */
  dropped: DropTally;
  /**
   * CNPJs harvested from registry-mirror results on this page.
   *
   * Unattributed on purpose: a mirror sits in the same result set as the
   * businesses, and NOTHING connects them. Pairing is decided later by
   * `verifyMirrorLink`, against the authoritative name.
   */
  cnpjHints: string[];
  /** Set when the engine refused or ran out. Ends the sweep; no query row is written. */
  stop?: string;
}

export const emptyTally = (): DropTally => ({
  mirror: 0,
  social: 0,
  nonBusiness: 0,
  document: 0,
  nonResult: 0,
  alreadySeen: 0,
});

/** The breakdown as one line, with only the buckets that actually caught anything. */
export function describeTally(t: DropTally): string {
  const parts: [string, number][] = [
    ["espelho de cadastro", t.mirror],
    ["rede social", t.social],
    ["marketplace/imprensa", t.nonBusiness],
    ["documento/processo", t.document],
    ["já visto", t.alreadySeen],
    ["não é resultado", t.nonResult],
  ];
  const hit = parts.filter(([, n]) => n > 0);
  return hit.length ? hit.map(([label, n]) => `${n} ${label}`).join(" · ") : "nada descartado";
}

export interface DiscoverySource {
  readonly engine: DiscoveryEngine;
  /** One query, possibly several billed pages. */
  fetch(query: string, budget: { left: number }): Promise<FetchResult>;
  close(): Promise<void>;
}

/** How many results per query each engine can be expected to return. */
export const ENGINE_YIELD: Record<DiscoveryEngine, number> = {
  places: PLACES_MAX_RESULTS,
  google: 10,
  duckduckgo: 12,
};

export function openSource(
  db: Db,
  engine: DiscoveryEngine,
  opts: { pagesPerQuery?: number } = {}
): DiscoverySource | { error: string } {
  const pages = Math.min(Math.max(opts.pagesPerQuery ?? 1, 1), 3);
  if (engine === "places") return placesSource(db, pages);
  return organicSource(db, engine, pages);
}

/**
 * How many results a page of organic search holds, per engine.
 *
 * Used as the pagination step, so page two starts where page one ended. Google
 * shows ten and its `start` counts results; DuckDuckGo's HTML endpoint pages in
 * blocks of thirty via `s`.
 *
 * `maxHits` is raised above the parser's default of twelve for the same reason
 * pagination exists at all: the page has already been fetched and paid for, so
 * discarding results from it throws away the only free part of the exchange. That
 * default was chosen for verifying one company by name, where a handful is plenty.
 */
const ORGANIC_PAGE: Record<"google" | "duckduckgo", { step: number; maxHits: number }> = {
  google: { step: 10, maxHits: 10 },
  duckduckgo: { step: 30, maxHits: 30 },
};

/**
 * Places, paginated.
 *
 * 20 per call is Google's cap, so pagination is the only way past it — and each
 * page is a billed call, which is why it draws from the same budget the queries
 * do rather than a separate one.
 */
function placesSource(db: Db, pages: number): DiscoverySource | { error: string } {
  const places = placesFor(db);
  if (!places) {
    return {
      error:
        "A busca pelo Places precisa de GOOGLE_MAPS_API_KEY no .env. A cota gratuita cobre 1.000 chamadas por mês, e cada uma devolve até 20 negócios com o site incluído.",
    };
  }

  const wanted = Math.min(Math.max(pages, 1), 3);

  return {
    engine: "places",
    async fetch(query, budget) {
      const candidates: Candidate[] = [];
      const seen = new Set<string>();
      const dropped = emptyTally();
      let considered = 0;
      let token: string | null = null;

      for (let page = 0; page < wanted; page++) {
        if (budget.left <= 0)
          return { candidates, considered, dropped, cnpjHints: [], stop: "orçamento" };
        let result;
        try {
          result = await places.client.searchBusinesses(query, { pageToken: token });
        } catch (err) {
          // The quota refusing is the expected end of a sweep, not a failure: the
          // free ceiling is monthly, and hitting it is information.
          return {
            candidates,
            considered,
            dropped,
            cnpjHints: [],
            stop: (err as Error).message,
          };
        }
        budget.left--;
        considered += result.businesses.length;

        for (const business of result.businesses) {
          // No website is the commonest drop here and is not a filter failing:
          // the premise is finding companies WITH a site.
          if (!business.websiteUrl) continue;
          if (isNonBusinessHost(business.websiteUrl)) {
            dropped.nonBusiness++;
            continue;
          }
          const apex = apexOf(business.websiteUrl);
          if (!apex) {
            dropped.nonResult++;
            continue;
          }
          if (seen.has(apex)) {
            dropped.alreadySeen++;
            continue;
          }
          seen.add(apex);
          candidates.push({
            websiteUrl: business.websiteUrl,
            apex,
            name: business.name,
            address: business.address,
            placeId: business.placeId,
          });
        }

        token = result.nextPageToken;
        // No token means Google has nothing more for this query. Spending the
        // next call to rediscover that would be spending it to learn nothing.
        if (!token) break;
      }
      return { candidates, considered, dropped, cnpjHints: [] };
    },
    async close() {},
  };
}

/**
 * Organic search — Google through the real browser, or DuckDuckGo over HTTP.
 *
 * The gates here are the inverse of the presence search's. There the finding is a
 * social profile and an aggregator is noise; here only `site` counts, because a
 * business's own page is the only thing that can be crawled and scored — and the
 * aggregator becomes evidence instead of noise, since its snippet carries a CNPJ.
 */
function organicSource(
  db: Db,
  engine: DiscoveryEngine,
  pages: number
): DiscoverySource | { error: string } {
  const chain = serpFor(db, {});
  if (!chain) {
    return {
      error:
        "A busca orgânica está desligada. Ligue com SERP_ENABLED=1 no .env — ela raspa o Google e o DuckDuckGo, então é uma decisão consciente.",
    };
  }

  const wanted = engine === "google" ? "google" : "duckduckgo";
  const provider: PresenceProvider | undefined = chain.providers.find((p) => p.name === wanted);
  if (!provider) {
    return {
      error:
        wanted === "google"
          ? "O Google só entra na busca com SERP_GOOGLE=on — ele bloqueia por IP e o bloqueio custa mais que o do DuckDuckGo."
          : "Nenhum buscador configurado.",
    };
  }

  return {
    engine,
    async fetch(query, budget) {
      const { step, maxHits } = ORGANIC_PAGE[engine === "google" ? "google" : "duckduckgo"];
      const candidates: Candidate[] = [];
      const hints = new Set<string>();
      const seen = new Set<string>();
      const dropped = emptyTally();
      let considered = 0;
      let stop: string | undefined;

      for (let pageNo = 0; pageNo < pages; pageNo++) {
        if (budget.left <= 0) {
          stop = "orçamento";
          break;
        }
        let page;
        try {
          page = await provider.search(query, { start: pageNo * step, maxHits });
        } catch (err) {
          stop = (err as Error).message;
          break;
        }
        budget.left--;

        // A refusal ends the sweep and — crucially — leaves whatever the earlier
        // pages found intact. Throwing those away would make a block on page two
        // indistinguishable from a query that found nothing.
        if (page.status === "blocked") {
          stop = page.reason;
          break;
        }
        if (page.status === "unrecognized") {
          stop = "a página de resultados mudou de formato";
          break;
        }
        // Nothing on this page means nothing on the next one either; paying for
        // it would be paying to rediscover that.
        if (page.status === "empty") break;

        considered += page.hits.length;
        collect(page.hits, candidates, hints, seen, dropped);
        // A short page is the last page.
        if (page.hits.length < maxHits) break;
      }

      return { candidates, considered, dropped, cnpjHints: [...hints], stop };
    },
    close: () => chain.close(),
  };

  /** The gates, applied to one page of hits. */
  function collect(
    hits: { url: string; title: string; description: string }[],
    candidates: Candidate[],
    hints: Set<string>,
    seen: Set<string>,
    dropped: DropTally
  ): void {
    for (const hit of hits) {
      if (isNonResult(hit.url)) {
        dropped.nonResult++;
        continue;
      }
      const kind = classifyHit(hit.url);

      // A mirror is not a lead, but its snippet is the only free source of a
      // CNPJ this project has. Diverted rather than dropped — which is exactly
      // the inversion the presence path cannot make.
      if (kind === "aggregator" || looksLikeRegistryMirror(hit)) {
        for (const cnpj of cnpjsFromHit(hit)) hints.add(cnpj);
        dropped.mirror++;
        continue;
      }

      // Only a business's own site. `social` and `linkedin` are findings on the
      // presence path and useless here: the crawler short-circuits link hubs
      // without fetching, so there would be nothing to read or score.
      if (kind !== "site") {
        if (kind === "social" || kind === "linkedin" || kind === "linkedin_company") {
          dropped.social++;
        } else {
          dropped.document++;
        }
        continue;
      }
      if (isNonBusinessHost(hit.url)) {
        dropped.nonBusiness++;
        continue;
      }
      const apex = apexOf(hit.url);
      if (!apex) {
        dropped.nonResult++;
        continue;
      }
      if (seen.has(apex)) {
        dropped.alreadySeen++;
        continue;
      }
      seen.add(apex);
      candidates.push({
        websiteUrl: hit.url,
        apex,
        name: hit.title || null,
        address: null,
        placeId: null,
      });
    }
  }
}

export { discoveryQuery };
