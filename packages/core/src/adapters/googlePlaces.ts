import type { HttpPort } from "../ports/index";
import { nodeHttp } from "../ports/index";

/**
 * Google Places, used for exactly one thing: finding a company's website.
 *
 * The Receita publishes no website column. That is the single most valuable
 * field it is missing, because the crawl and the scoring both depend on it, and
 * an own-domain e-mail only exists for a small minority of companies. This is
 * the way to close that gap — and it is the only part of this project that can
 * spend money, which is why it asks for one field and stores two.
 *
 * Google's terms permit storing `place_id` indefinitely and nothing else. Names,
 * phone numbers, addresses and ratings may not be cached at all. So they are
 * never requested: the field mask below is the enforcement, because a field that
 * was never fetched cannot be stored by accident.
 */

const BASE_URL = "https://places.googleapis.com/v1";

/**
 * The field mask decides the SKU, and the SKU decides the bill.
 *
 * `websiteUri` is an Enterprise-tier field, so this is the Text Search
 * Enterprise SKU — 1,000 free calls a month. Asking for it in the search
 * response rather than doing search-then-details halves the quota spent per
 * company, because the two-call shape would bill a Text Search *and* a Details.
 */
export const WEBSITE_FIELD_MASK = "places.id,places.websiteUri";

/** The SKU this adapter bills against. Named so the budget can key on it. */
export const PLACES_SKU = "textsearch.enterprise";

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

export interface PlaceWebsite {
  placeId: string;
  websiteUrl: string | null;
}

export interface GooglePlacesOptions {
  apiKey: string;
  http?: HttpPort;
  /**
   * Called before every billable request. Throwing here stops the spend, so
   * the budget check has to happen inside rather than at the call site.
   */
  beforeRequest?: () => Promise<void> | void;
  afterRequest?: () => Promise<void> | void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Google asks for at most one QPS on the free tier; be slower than that. */
const MIN_INTERVAL_MS = 1200;

export function createGooglePlaces(opts: GooglePlacesOptions) {
  const http = opts.http ?? nodeHttp;
  let lastCallAt = 0;

  /**
   * Finds the website for one company.
   *
   * Returns null when Google has no match, which is a real answer and not an
   * error: plenty of small businesses are simply not on Maps.
   */
  async function findWebsite(query: string): Promise<PlaceWebsite | null> {
    await opts.beforeRequest?.();

    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    let res: Response;
    try {
      res = await http.fetch(`${BASE_URL}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": opts.apiKey,
          "X-Goog-FieldMask": WEBSITE_FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: "pt-BR",
          regionCode: "BR",
          // One result. Extra results would be billed the same but tempt the
          // caller into guessing between them.
          maxResultCount: 1,
        }),
      });
    } catch (err) {
      throw new PlacesError(`erro de rede no Places: ${(err as Error).message}`);
    }

    // Counted whether or not it matched: a search that returns nothing is still
    // a billed search.
    await opts.afterRequest?.();

    if (!res.ok) {
      throw new PlacesError(
        `Places ${res.status}: ${(await res.text()).slice(0, 300)}`,
        res.status
      );
    }

    const data = (await res.json()) as {
      places?: { id?: string; websiteUri?: string }[];
    };
    const place = data.places?.[0];
    if (!place?.id) return null;

    return { placeId: place.id, websiteUrl: place.websiteUri ?? null };
  }

  return { findWebsite };
}

/**
 * The search string. Name plus city plus state, nothing else.
 *
 * A bare company name matches the wrong business in another state often enough
 * to be useless, and the Receita always has município and UF.
 */
export function placesQuery(input: {
  nomeFantasia: string | null;
  razaoSocial: string | null;
  municipio: string | null;
  uf: string | null;
}): string | null {
  const name = (input.nomeFantasia ?? input.razaoSocial ?? "").trim();
  if (!name) return null;
  return [name, input.municipio, input.uf].filter(Boolean).join(", ");
}
