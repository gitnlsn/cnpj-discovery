import type { LlmPort } from "../ports/index";
import type { ProjectSpec } from "../domain/spec";
import { tierFor, bestFit } from "../domain/spec";
import { buildRubricPrompt, buildScoreSchema, promptSha } from "../domain/prompt";

/**
 * Scores companies against a project's rubric.
 *
 * The invariants worth stating, because each was paid for:
 *
 * - A failed call writes `error` with every fit null. It NEVER writes a number.
 *   A fabricated 5 is indistinguishable from a real one and silently poisons
 *   the ranking.
 * - `tier` is computed here from the fits, never requested from the model.
 * - The model may reject a company by line of business (`wrongType`) instead of
 *   having to squeeze that into a 1-5 score. A CNAE is a coarse gate: "cursos
 *   preparatórios" genuinely contains a ballooning company and an oncology
 *   clinic, and without this they all scored 5.
 * - The prompt and schema are built once per run, before the loop, so the
 *   system message is constant and stays prompt-cacheable.
 */

/** How much page text the model gets per company. */
const PAGE_EXCERPT_CHARS = 700;
/**
 * Below this many characters read, a probe miss proves nothing. Above it,
 * "read the whole page and the term never appeared" is real evidence.
 */
const CONCLUSIVE_TEXT_CHARS = 1500;
/**
 * How much of a human impression the model gets.
 *
 * Larger than the page excerpt on purpose: a person writes three lines, not a
 * homepage, and every one of them was typed deliberately.
 */
const IMPRESSION_CHARS = 1200;
/**
 * How much of the page's own declared description the model gets.
 *
 * Its own line rather than part of the page excerpt: a meta description is one
 * curated sentence, and on a page that rendered nothing it is the only evidence
 * there is. It must not have to compete with nav text for the excerpt window.
 */
const DECLARED_CHARS = 400;
/** How many verified search hits reach the model, and how much of each. */
const PRESENCE_HITS = 3;
const PRESENCE_DESC_CHARS = 300;

export interface ScoreCandidate {
  /**
   * The join key the model must echo back.
   *
   * A CNPJ for a company from the Receita, the registrable domain for a business
   * found on the open internet. Renamed from `cnpj` because it stopped being one:
   * an open-internet lead has no registry number — finding it is the point of the
   * run — and calling the key `cnpj` would mean inventing a value to fill it.
   *
   * That invention is the same error a fabricated fit score would be. A synthetic
   * CNPJ would reach the detail sheet, the CSV export and `contacts.cnpj`, filing
   * a phone number under a number that does not exist.
   */
  id: string;
  /**
   * The registry number, when there IS one.
   *
   * A fact about the company rather than its key, which is why it is optional and
   * nullable. Null means "we do not know it", never "it has none".
   */
  cnpj?: string | null;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnae: string;
  cnaeDescricao: string | null;
  uf: string | null;
  municipio: string | null;
  dataInicioAtividade: string | null;
  porte: string | null;
  mei: boolean;
  /**
   * What a person wrote after looking at this company themselves.
   *
   * Null or empty for almost every company — it exists only where somebody
   * stopped and typed something, which is exactly why it outweighs the probes.
   */
  impression?: string | null;
  /**
   * Verified web-search hits, when the company had no readable site.
   *
   * Its own field rather than part of `site` because it is not a property of a
   * page we fetched — for a social hit we never fetch anything, and the search
   * snippet is all that will ever exist. Empty or absent for a company that was
   * never searched, which is distinct from one searched with nothing found.
   */
  webPresence?: {
    url: string;
    title: string;
    description: string;
    kind: string;
  }[];
  /** Null when the site was never crawled — distinct from a crawl that failed. */
  site: {
    finalUrl: string | null;
    isDead: boolean;
    isLinkHub: boolean;
    isFreeBuilder: boolean;
    hasViewport: boolean | null;
    hasWaLink: boolean | null;
    hasContactPath: boolean | null;
    platform: string | null;
    footerYear: number | null;
    title: string | null;
    textExcerpt: string | null;
    /**
     * What the page declares about itself — meta description and JSON-LD.
     *
     * Separate from `textExcerpt` because it is not prose the crawler read, and
     * `textExcerpt.length` is what decides whether a probe miss is conclusive.
     * On a thin page this is frequently the only sentence saying what the
     * business does.
     */
    structuredText: string | null;
    /** 200 OK but rendered nothing without JavaScript, so the page is unread. */
    isJsShell: boolean | null;
    probes: Record<string, boolean>;
  } | null;
}

export interface ScoreResult {
  /** Echoes `ScoreCandidate.id`, so a result can be attached to its candidate. */
  id: string;
  fits: Record<string, number | null>;
  bestFit: number | null;
  tier: "hot" | "warm" | "cold" | null;
  confidence: "high" | "medium" | "low" | "cannot_determine" | null;
  recommendation: string | null;
  wrongType: boolean;
  hook: string | null;
  advice: string | null;
  evidence: { evidence: string[]; justification: string } | null;
  model: string | null;
  promptSha: string;
  error: string | null;
}

function years(from: string | null): string {
  if (!from) return "idade desconhecida";
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return "idade desconhecida";
  const y = (Date.now() - start) / (365.25 * 24 * 3600 * 1000);
  return y < 1 ? "aberta há menos de 1 ano" : `aberta há ${Math.floor(y)} anos`;
}

/**
 * Renders one company as a compact fact line.
 *
 * Probe hits AND misses are both rendered. Sending only the hits is what let an
 * earlier version conflate "we read the page and the term was not there" with
 * "we never read the page", and the model has no way to recover the difference.
 */
export function renderCandidate(c: ScoreCandidate, spec: ProjectSpec): string {
  // `renderCandidate` builds the USER message, which `promptSha` does not hash —
  // so this can change shape freely without restating what graded an old lead.
  const f: string[] = [
    c.cnpj ? `cnpj: ${c.cnpj}` : `ref: ${c.id}`,
    `nome: ${c.nomeFantasia ?? c.razaoSocial ?? "(sem nome)"}`,
    // Said outright rather than omitted. A missing line invites the model to
    // reason from the absence; a stated one tells it the absence means nothing.
    // Same reasoning as "site: NÃO VERIFICADO" below.
    c.cnae
      ? `cnae: ${c.cnae}${c.cnaeDescricao ? ` (${c.cnaeDescricao})` : ""}`
      : `cnae: não encontrado na Receita (não sabemos)`,
    `local: ${c.municipio ?? "?"}/${c.uf ?? "?"}`,
    years(c.dataInicioAtividade),
  ];
  if (c.porte) f.push(`porte: ${c.porte}`);
  if (c.mei) f.push("MEI");

  const detail = spec.rubric.siteSignals;
  if (detail !== "none") {
    if (!c.site) {
      f.push("site: NÃO VERIFICADO");
    } else if (c.site.isLinkHub) {
      f.push("site: só link na bio (Instagram/Linktree), página não lida");
    } else if (c.site.isDead) {
      f.push("site: fora do ar");
    } else if (!c.site.finalUrl) {
      f.push("site: NÃO ENCONTRADO");
    } else {
      f.push(`site: ${c.site.finalUrl}`);
      if (detail === "full") {
        if (c.site.title) f.push(`título: ${c.site.title}`);
        if (c.site.platform) f.push(`plataforma: ${c.site.platform}`);
        if (c.site.isFreeBuilder) f.push("construtor grátis");
        if (c.site.footerYear) f.push(`rodapé: ${c.site.footerYear}`);
        if (c.site.hasViewport === false) f.push("não responsivo");
        if (c.site.hasWaLink === true) f.push("tem link de WhatsApp");
        if (c.site.hasContactPath === false) f.push("sem caminho de contato");
        // Said outright, because "a URL with no text" would otherwise read
        // as an empty business rather than a page we could not read.
        if (c.site.isJsShell) f.push("página não abre sem JavaScript — não foi lida");
      }
    }
  }

  const lines = [`- ${f.join(" | ")}`];

  if (spec.probes.length && c.site) {
    const probes = c.site.probes ?? {};
    const hits = spec.probes.filter((p) => probes[p.key] === true).map((p) => p.label);
    const misses = spec.probes.filter((p) => probes[p.key] === false).map((p) => p.label);
    const read = c.site.textExcerpt?.length ?? 0;
    if (hits.length) lines.push(`  encontrado na página: ${hits.join(", ")}`);
    if (misses.length) {
      lines.push(`  procurado e NÃO encontrado (li ${read} caracteres): ${misses.join(", ")}`);
    }
    // Say it outright rather than hoping the model infers it.
    if (!hits.length && read >= CONCLUSIVE_TEXT_CHARS) {
      lines.push(
        `  CONFLITO: li a página inteira (${read} caracteres) e NENHUM sinal do produto apareceu.`
      );
    }
  }

  // Before the page text: it is shorter, denser, and written on purpose.
  if (c.site?.structuredText) {
    lines.push(
      `  descrição declarada pelo site: ${c.site.structuredText.slice(0, DECLARED_CHARS)}`
    );
  }

  if (c.site?.textExcerpt) {
    lines.push(`  texto da página: ${c.site.textExcerpt.slice(0, PAGE_EXCERPT_CHARS)}`);
  }

  // Before the impression, after the page: this is machine-verified evidence,
  // so it ranks below what a person saw with their own eyes and above nothing.
  const presence = c.webPresence ?? [];
  if (presence.length) {
    const kinds = [...new Set(presence.map((p) => p.kind))].join("/");
    lines.push(`  presença na web (nome confirmado, ${kinds}):`);
    for (const hit of presence.slice(0, PRESENCE_HITS)) {
      const desc = hit.description.trim();
      lines.push(
        `    - ${hit.url}${hit.title ? ` — ${hit.title.slice(0, 120)}` : ""}` +
          // The description is the part that says what the business does; the
          // URL only says the person exists.
          (desc
            ? `\n      descrição: ${desc.slice(0, PRESENCE_DESC_CHARS)}`
            : "\n      (sem descrição — só confirma a pessoa, não o ramo)")
      );
    }
  }

  // Last, and fenced. The fence is not decoration: this is the one block in the
  // rendering a person typed by hand, and the model has to be able to tell where
  // the evidence ends and its own instructions resume.
  const impression = c.impression?.trim();
  if (impression) {
    lines.push(`  impressão de quem olhou: <<<${impression.slice(0, IMPRESSION_CHARS)}>>>`);
  }

  return lines.join("\n");
}

interface RawResult {
  cnpj?: string;
  /** The same field under the name an open-internet run asks for. */
  ref?: string;
  justification?: string;
  wrong_business_type?: boolean;
  confidence?: string;
  recommendation?: string;
  evidence?: string[];
  hook?: string | null;
  advice?: string | null;
  [axis: string]: unknown;
}

const CONFIDENCES = ["high", "medium", "low", "cannot_determine"] as const;

function failed(id: string, sha: string, error: string): ScoreResult {
  return {
    id,
    fits: {},
    bestFit: null,
    tier: null,
    confidence: null,
    recommendation: null,
    wrongType: false,
    hook: null,
    advice: null,
    evidence: null,
    model: null,
    promptSha: sha,
    error,
  };
}

export interface ScoreOptions {
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Which property the model echoes to identify each business.
   *
   * "cnpj" by default, so an ordinary run produces the byte-identical system
   * prompt it always did and keeps its promptSha. "ref" is for open-internet
   * leads, whose key is a domain.
   */
  keyField?: "cnpj" | "ref";
  /** Adds `WEB_LEAD_RULES` — see the note there on why absence is not evidence. */
  withWebLead?: boolean;
}

export async function scoreCompanies(
  llm: LlmPort,
  spec: ProjectSpec,
  candidates: ScoreCandidate[],
  opts: ScoreOptions = {}
): Promise<ScoreResult[]> {
  if (candidates.length === 0) return [];

  // Built once, outside the loop: constant system message, cacheable prompt.
  // The impression rules are part of that constant — decided from the whole run,
  // not per batch, so promptSha means one thing for the run.
  const withImpressions = candidates.some((c) => Boolean(c.impression?.trim()));
  const withWebPresence = candidates.some((c) => Boolean(c.webPresence?.length));
  const withLinkedIn = candidates.some((c) =>
    c.webPresence?.some((p) => p.kind === "linkedin")
  );
  const key = opts.keyField ?? "cnpj";
  const system = buildRubricPrompt(spec, {
    withImpressions,
    withWebPresence,
    withLinkedIn,
    withWebLead: opts.withWebLead,
    key,
  });
  const schema = buildScoreSchema(spec, { key });
  const sha = promptSha(system);
  const axisKeys = spec.rubric.axes.map((a) => a.key);
  const batchSize = Math.min(Math.max(opts.batchSize ?? 10, 1), 20);

  const out: ScoreResult[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const user = batch.map((c) => renderCandidate(c, spec)).join("\n\n");

    let results: RawResult[];
    let model: string | null;
    try {
      const res = await llm.completeJson<{ results?: RawResult[] } | RawResult[]>({
        task: "score",
        schemaName: "scores",
        schema,
        maxTokens: 400 * batch.length + 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      model = res.model;
      // Tolerate the three shapes models actually return.
      const v = res.value as { results?: RawResult[]; leads?: RawResult[] } | RawResult[];
      results = Array.isArray(v) ? v : (v.results ?? v.leads ?? []);
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      for (const c of batch) out.push(failed(c.id, sha, message));
      opts.onProgress?.(Math.min(i + batchSize, candidates.length), candidates.length);
      continue;
    }

    // Normalisation has to know what the key IS.
    //
    // The digits-only strip exists because a model asked for a CNPJ will happily
    // return it formatted. Applied to a key that is not a number it is a bug with
    // no symptom of its own: every id collapses to "" , every entry overwrites the
    // last, and all but one candidate come back as "the model did not answer" —
    // which reads as a model problem rather than a lookup problem.
    const normalize = (raw: unknown): string =>
      key === "cnpj" ? String(raw ?? "").replace(/\D/g, "") : String(raw ?? "").trim();

    const byKey = new Map(results.map((r) => [normalize(key === "cnpj" ? r.cnpj : r.ref), r]));

    for (const c of batch) {
      const r = byKey.get(normalize(c.id));
      if (!r) {
        out.push(failed(c.id, sha, "modelo não devolveu resultado para este negócio"));
        continue;
      }

      const fits: Record<string, number | null> = {};
      for (const key of axisKeys) {
        const raw = r[key];
        const n = typeof raw === "number" ? raw : Number(raw);
        fits[key] = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
      }

      const justification = String(r.justification ?? "");
      // The model has been observed writing "o site é de outro ramo" while
      // leaving the boolean false. The forced [RAMO: ...] tag is the tiebreak,
      // and the two are OR-ed so either signal is enough.
      const wrongType =
        r.wrong_business_type === true || /\[RAMO:\s*errado\]/i.test(justification);

      const confidence = CONFIDENCES.includes(r.confidence as never)
        ? (r.confidence as ScoreResult["confidence"])
        : null;

      const best = bestFit(fits);
      out.push({
        id: c.id,
        fits,
        bestFit: best,
        tier: tierFor(fits),
        confidence,
        recommendation: r.recommendation ? String(r.recommendation).slice(0, 40) : null,
        wrongType,
        hook: r.hook ? String(r.hook).slice(0, 500) : null,
        advice: r.advice ? String(r.advice).slice(0, 500) : null,
        evidence: {
          // Capped, unlike the version this came from, where it was the one
          // text column with no length guard.
          evidence: (r.evidence ?? []).map((e) => String(e).slice(0, 300)).slice(0, 10),
          justification: justification.slice(0, 2000),
        },
        model,
        promptSha: sha,
        error: null,
      });
    }

    opts.onProgress?.(Math.min(i + batchSize, candidates.length), candidates.length);
  }

  return out;
}
