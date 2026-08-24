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

/**
 * The mask for discovery, where the question is "which businesses are here".
 *
 * Three fields more than the lookup mask, and **the same SKU** — the tier billed
 * is the highest tier requested, `websiteUri` is already Enterprise, and
 * `displayName`/`formattedAddress` are Pro. So the name and the address cost
 * nothing extra on a call that was going to ask for the website anyway.
 *
 * That is what makes discovery affordable here: one billed call returns up to
 * twenty businesses complete with the website — the exact field Google Maps'
 * own results feed withholds, which was measured and is why the browser route was
 * abandoned.
 *
 * Storage is a separate question from retrieval, and the project's stance does not
 * change: the name and the address are used **in the run** to find the company in
 * the Receita base and are then discarded. What persists is the `place_id`, plus
 * the CNPJ we matched — which is public Receita data, not Google's.
 */
export const DISCOVERY_FIELD_MASK =
  "places.id,places.websiteUri,places.displayName,places.formattedAddress,nextPageToken";

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

/**
 * One business as discovery sees it.
 *
 * `name` and `address` are deliberately NOT part of `PlaceWebsite`: that type
 * describes what may be stored, and these two may not be. They live here, in the
 * shape that crosses the wire and dies with the run.
 */
export interface PlaceBusiness {
  placeId: string;
  websiteUrl: string | null;
  /** Transient. For matching against the Receita, never for a column. */
  name: string | null;
  /** Transient, same rule. Google's `formattedAddress`. */
  address: string | null;
}

export interface PlaceSearchPage {
  businesses: PlaceBusiness[];
  /** Pass back as `pageToken` for the next twenty. Each page is a billed call. */
  nextPageToken: string | null;
}

/** Google caps `searchText` at twenty results per call. */
export const PLACES_MAX_RESULTS = 20;

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

  /**
   * Businesses matching a category-and-place query — the discovery direction.
   *
   * The inverse of `findWebsite`, which starts from a company we already know and
   * asks Google for its site. This starts from Google and asks which businesses
   * exist, which is the only direction that can surface a company the Receita
   * query never reached.
   *
   * One call, up to twenty businesses, each with its website. Compare the browser
   * route this replaced: a Maps results feed gives about seven cards and **no**
   * website, so the site cost a further page load per business — roughly eight
   * loads for seven businesses, against one call for twenty, with blocking and
   * account risk on top.
   *
   * `locationBias` is how geography is actually controlled. Putting a city name in
   * the query text is only a hint, and on Maps it demonstrably drifted — a search
   * for São Paulo returned businesses from the ABC region. A circle with real
   * coordinates is unambiguous.
   */
  async function searchBusinesses(
    query: string,
    search: {
      /** Continues a previous page. Do not change the query when passing one. */
      pageToken?: string | null;
      maxResults?: number;
      locationBias?: { latitude: number; longitude: number; radiusMeters: number };
    } = {}
  ): Promise<PlaceSearchPage> {
    await opts.beforeRequest?.();

    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    const body: Record<string, unknown> = {
      textQuery: query,
      languageCode: "pt-BR",
      regionCode: "BR",
      maxResultCount: Math.min(
        Math.max(search.maxResults ?? PLACES_MAX_RESULTS, 1),
        PLACES_MAX_RESULTS
      ),
    };
    if (search.pageToken) body.pageToken = search.pageToken;
    if (search.locationBias) {
      const { latitude, longitude, radiusMeters } = search.locationBias;
      body.locationBias = { circle: { center: { latitude, longitude }, radius: radiusMeters } };
    }

    let res: Response;
    try {
      res = await http.fetch(`${BASE_URL}/places:searchText`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": opts.apiKey,
          "X-Goog-FieldMask": DISCOVERY_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new PlacesError(`erro de rede no Places: ${(err as Error).message}`);
    }

    // Billed whether or not anything matched, so counted before the status check.
    await opts.afterRequest?.();

    if (!res.ok) {
      throw new PlacesError(
        `Places ${res.status}: ${(await res.text()).slice(0, 300)}`,
        res.status
      );
    }

    const data = (await res.json()) as {
      places?: {
        id?: string;
        websiteUri?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
      }[];
      nextPageToken?: string;
    };

    const businesses: PlaceBusiness[] = [];
    for (const place of data.places ?? []) {
      // No id, no business: the id is the only durable handle, and a row without
      // one could never be de-duplicated across runs.
      if (!place.id) continue;
      businesses.push({
        placeId: place.id,
        websiteUrl: place.websiteUri ?? null,
        name: place.displayName?.text ?? null,
        address: place.formattedAddress ?? null,
      });
    }

    return { businesses, nextPageToken: data.nextPageToken ?? null };
  }

  return { findWebsite, searchBusinesses };
}

/**
 * A discovery query for the Places API.
 *
 * Plain text, because that is what `searchText` takes: the activity and the place,
 * in the order a person would type them. The quoting that organic search needs is
 * pointless here — Places is not matching a document, it is matching a business.
 */
export function discoveryQuery(term: string, place: string | null): string {
  const activity = term.trim();
  if (!activity) return "";
  const where = (place ?? "").trim();
  return where ? `${activity} em ${where}` : activity;
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
