import "server-only";
import { inArray } from "drizzle-orm";
import { searchHits, type crawls, type Db } from "@cnpj/db";
import { linkedInIsEvidence, type ScoreCandidate, type SiteSignals } from "@cnpj/core";

/**
 * One place that turns rows into a `ScoreCandidate`.
 *
 * There were three copies of this literal — in `scoring.ts`, `pipeline.ts` and
 * `continuous.ts` — identical apart from where the site block came from. Adding
 * the human impression to two of them by hand would have made it four, and the
 * copies were already the reason a field could be present in one path and
 * silently missing from another.
 *
 * Two site builders, not one, because the crawl writes its `SiteSignals` to a
 * `crawls` row and `continuous.ts` still has them in memory when it scores.
 */

type CrawlRow = typeof crawls.$inferSelect;

/** The Receita facts every candidate needs, from a `companies` row or a base row. */
export interface CompanyFacts {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnae: string;
  cnaeDescricao: string | null;
  uf: string | null;
  municipio: string | null;
  dataInicioAtividade: string | null;
  porte: string | null;
  mei: boolean;
}

/**
 * Null when there is no crawl row at all.
 *
 * That null is not the same as a crawl that found nothing, and the prompt
 * renders the two differently — "site: NÃO VERIFICADO" versus "NÃO ENCONTRADO".
 */
export function siteFromCrawl(crawl: CrawlRow | null | undefined): ScoreCandidate["site"] {
  if (!crawl) return null;
  const s = crawl.signals as SiteSignals | null;
  return {
    finalUrl: crawl.finalUrl,
    isDead: s?.isDead ?? false,
    isLinkHub: s?.isLinkHub ?? false,
    isFreeBuilder: s?.isFreeBuilder ?? false,
    hasViewport: s?.hasViewport ?? null,
    hasWaLink: s?.hasWaLink ?? null,
    hasContactPath: s?.hasContactPath ?? null,
    platform: s?.platform ?? null,
    footerYear: s?.footerYear ?? null,
    title: s?.title ?? null,
    textExcerpt: crawl.textExcerpt,
    structuredText: s?.structuredText ?? null,
    isJsShell: s?.isJsShell ?? null,
    probes: s?.probes ?? {},
  };
}

/** The same block, from signals that have not been written to a row yet. */
export function siteFromSignals(s: SiteSignals): ScoreCandidate["site"] {
  return {
    finalUrl: s.finalUrl,
    isDead: s.isDead,
    isLinkHub: s.isLinkHub,
    isFreeBuilder: s.isFreeBuilder,
    hasViewport: s.hasViewport,
    hasWaLink: s.hasWaLink,
    hasContactPath: s.hasContactPath,
    platform: s.platform,
    footerYear: s.footerYear,
    title: s.title,
    textExcerpt: s.textExcerpt,
    structuredText: s.structuredText,
    isJsShell: s.isJsShell,
    probes: s.probes,
  };
}

/**
 * Is there anything here for the model to read?
 *
 * The gate that decides whether a company costs an LLM call or gets a synthetic
 * `cannot_determine` row. It lived inline in `pipeline.ts` and `continuous.ts` as
 * `textExcerpt.trim().length > 0`, which had two problems: the two copies could
 * drift, and rendered text was the only thing it counted.
 *
 * A page that declares a description in its meta tags or JSON-LD is readable
 * even when it rendered nothing — that is the whole point of extracting it. And
 * a JS shell with nothing declared is explicitly NOT readable, where before its
 * nav text counted as content and bought a real scoring call for a page nobody
 * could read.
 */
export function hasReadableContent(
  source: {
    textExcerpt: string | null;
    structuredText: string | null;
    isJsShell: boolean | null;
  } | null
): boolean {
  if (!source) return false;
  if (source.structuredText?.trim()) return true;
  if (source.isJsShell) return false;
  return Boolean(source.textExcerpt?.trim());
}

/** The same question, for a `crawls` row rather than in-memory signals. */
export function crawlIsReadable(crawl: CrawlRow | null | undefined): boolean {
  if (!crawl) return false;
  const s = crawl.signals as SiteSignals | null;
  return hasReadableContent({
    textExcerpt: crawl.textExcerpt,
    structuredText: s?.structuredText ?? null,
    isJsShell: s?.isJsShell ?? null,
  });
}

/**
 * The verified search hits for one company, shaped for the prompt.
 *
 * Only `social` and `site` kinds are ever stored, so no filtering is needed
 * here — the gate that matters already ran in `verifyHits`. An empty array and
 * `undefined` mean different things to the renderer, so an absent search stays
 * absent rather than becoming "searched, found nothing".
 */
export type SearchHitRow = {
  url: string;
  title: string | null;
  description: string | null;
  kind: string | null;
  headline: string | null;
};

/**
 * Which stored hits reach the model, and in what shape.
 *
 * The evidence decision lives here rather than in the writer, so the rule can be
 * improved without a migration or a backfill of rows already on disk — and it
 * lives here rather than in `loadPresence` because it needs the company's own
 * razão social, which is only in scope once `toScoreCandidate` has the facts.
 *
 * A LinkedIn hit that does not qualify is not dropped from the database, only
 * from the prompt. That is the whole point of the split: the row stays as an
 * audit trail and as the denominator for "is LinkedIn worth keeping at all".
 */
export function presenceFromHits(
  rows: SearchHitRow[] | undefined,
  razaoSocial: string | null = null
): ScoreCandidate["webPresence"] {
  if (!rows?.length) return undefined;

  const out = rows
    .filter((r) =>
      r.kind === "linkedin" ? linkedInIsEvidence({ headline: r.headline }, razaoSocial) : true
    )
    .map((r) => ({
      url: r.url,
      title: r.title ?? "",
      description:
        // For LinkedIn the headline IS the description: it is the field that
        // says what the person does, and the snippet is usually the site's own
        // marketing copy.
        r.kind === "linkedin" ? (r.headline ?? "") : (r.description ?? ""),
      kind: r.kind ?? "site",
    }));

  return out.length ? out : undefined;
}

export function toScoreCandidate(
  c: CompanyFacts,
  site: ScoreCandidate["site"],
  impression: string | null = null,
  hits: SearchHitRow[] | undefined = undefined
): ScoreCandidate {
  const webPresence = presenceFromHits(hits, c.razaoSocial);
  return {
    cnpj: c.cnpj,
    razaoSocial: c.razaoSocial,
    nomeFantasia: c.nomeFantasia,
    cnae: c.cnae,
    cnaeDescricao: c.cnaeDescricao,
    uf: c.uf,
    municipio: c.municipio,
    dataInicioAtividade: c.dataInicioAtividade,
    porte: c.porte,
    mei: c.mei,
    impression,
    site,
    webPresence,
  };
}

/**
 * Verified search hits for a set of companies, ready for `toScoreCandidate`.
 *
 * One query for the batch rather than one per company: this runs inside the
 * scoring loop, and the previous project's N+1 in exactly this spot is why the
 * batch shape is the default here.
 *
 * A company absent from the returned map was never searched, which the renderer
 * treats differently from one searched with nothing found — `search_lookups`
 * holds that second fact.
 */
/**
 * How well-founded each kind of hit is, best first.
 *
 * Only `PRESENCE_HITS` of them reach the model, so this decides what gets cut. A
 * site we can actually crawl outranks a social profile whose bio is the
 * storefront, and both outrank a LinkedIn headline — because on LinkedIn every
 * field is derived from the name, so it is the one kind where we are least sure
 * we have the right person at all.
 */
const KIND_RANK: Record<string, number> = { site: 0, social: 1, linkedin: 2 };

export async function loadPresence(
  db: Db,
  cnpjs: string[]
): Promise<Map<string, SearchHitRow[]>> {
  const out = new Map<string, SearchHitRow[]>();
  if (!cnpjs.length) return out;

  const rows = await db
    .select({
      cnpj: searchHits.cnpj,
      url: searchHits.url,
      title: searchHits.title,
      description: searchHits.description,
      kind: searchHits.kind,
      headline: searchHits.headline,
    })
    .from(searchHits)
    .where(inArray(searchHits.cnpj, cnpjs));

  const byCnpj = new Map<string, SearchHitRow[]>();
  for (const r of rows) {
    const list = byCnpj.get(r.cnpj) ?? [];
    list.push(r);
    byCnpj.set(r.cnpj, list);
  }
  for (const [cnpj, list] of byCnpj) {
    list.sort(
      (a, b) => (KIND_RANK[a.kind ?? "site"] ?? 9) - (KIND_RANK[b.kind ?? "site"] ?? 9)
    );
    out.set(cnpj, list);
  }
  return out;
}
