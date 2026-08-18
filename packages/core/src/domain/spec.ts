import type { IcpCriterion } from "./icp";

/**
 * What an ideal customer profile becomes once the model has compiled it.
 *
 * The model authors this, so nothing here is trusted on the way in:
 * `parseProjectSpec` is a validation boundary, not a cast. Everything it
 * rejects is rejected loudly — a spec that silently loses half its probes
 * produces a shortlist nobody can explain.
 */

export type Channel = "mobile" | "landline";
export type SiteDetail = "full" | "minimal" | "none";

export interface Targeting {
  /** CNAE codes or prefixes. "8599" matches every 8599xxx. */
  cnaePrefixes: string[];
  cnaeExclude: string[];
  ufs: string[];
  channels: Channel[];
  /** Legal-nature prefixes: 2 = private company, 3 = nonprofit. */
  naturezaPrefixes: string[];
  excludeMei: boolean;
  matrizOnly: boolean;
  minCapitalSocial: number | null;
  /** Company age in years, from data_inicio_atividade. */
  minAgeYears: number | null;
  maxAgeYears: number | null;
  requireNomeFantasia: boolean;
}

export interface Probe {
  key: string;
  label: string;
  /** Literal terms, never regexes — see probes.ts for why. */
  terms: string[];
  /** positive = a reason to contact them; negative = a reason not to. */
  meaning: "positive" | "negative";
  weight: number;
}

export interface Axis {
  key: string;
  label: string;
  question: string;
  /** Higher ALWAYS means a better fit. Enforced in the prompt and validated here. */
  anchors: { "1": string; "2": string; "3": string; "4": string; "5": string };
}

export interface Recommendation {
  value: string;
  label: string;
  when: string;
}

export interface Rubric {
  axes: Axis[];
  recommendations: Recommendation[];
  notes: string[];
  /** How much of the crawled site detail to spend tokens on. */
  siteSignals: SiteDetail;
  hookBad: string[];
  hookGood: string[];
}

export interface ProjectSpec {
  schemaVersion: 1;
  summary: string;
  buyer: string;
  problem: string;
  targeting: Targeting;
  probes: Probe[];
  rubric: Rubric;
  /** Which ICP criteria became filters, and which could not. */
  icpCoverage: IcpCriterion[];
}

/**
 * Hard caps. These are not style preferences: an unbounded axis list becomes an
 * unbounded JSON schema, and a free model handed a 40-field strict schema
 * returns malformed JSON rather than refusing.
 */
export const LIMITS = {
  maxAxes: 3,
  maxProbes: 12,
  maxProbeTerms: 8,
  maxCnaePrefixes: 40,
  maxUfs: 27,
  maxRecommendations: 6,
  maxNotes: 8,
  maxHookExamples: 4,
  maxIcpCriteria: 20,
  maxTextLen: 400,
  maxCriterionLen: 200,
} as const;

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, max: number = LIMITS.maxTextLen): string {
  if (typeof v !== "string" || !v.trim()) throw new SpecError(`${field}: texto obrigatório`);
  return v.trim().slice(0, max);
}

/**
 * Models emit the *string* "null" surprisingly often, and it reads as data.
 *
 * Seen in the ICP coverage panel, whose whole job is to say why a criterion
 * could not become a filter: rendering "null" there is worse than rendering
 * nothing, because it looks like an answer.
 */
const NULLISH = new Set(["null", "undefined", "none", "n/a", "na", "-"]);

function optStr(v: unknown, max: number = LIMITS.maxTextLen): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || NULLISH.has(t.toLowerCase())) return null;
  return t.slice(0, max);
}

function strArray(
  v: unknown,
  field: string,
  max: number,
  itemMax: number = LIMITS.maxTextLen
): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new SpecError(`${field}: esperava uma lista`);
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, itemMax))
    .filter(Boolean);
  return [...new Set(out)].slice(0, max);
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function optNum(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/** CNAE codes are digits only; the model likes to write "8599-6/05". */
function cleanCnae(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length >= 2 && d.length <= 7 ? d : null;
}

function parseTargeting(v: unknown): Targeting {
  const t = isRecord(v) ? v : {};
  return {
    // Strip punctuation before length-checking: the model writes "8599-6/05",
    // and truncating to seven characters first would leave "85996".
    cnaePrefixes: strArray(t.cnaePrefixes, "targeting.cnaePrefixes", LIMITS.maxCnaePrefixes, 20)
      .map(cleanCnae)
      .filter((c): c is string => c !== null),
    cnaeExclude: strArray(t.cnaeExclude, "targeting.cnaeExclude", LIMITS.maxCnaePrefixes, 20)
      .map(cleanCnae)
      .filter((c): c is string => c !== null),
    ufs: strArray(t.ufs, "targeting.ufs", LIMITS.maxUfs, 2).map((u) => u.toUpperCase()),
    channels: (Array.isArray(t.channels) ? t.channels : []).filter(
      (c): c is Channel => c === "mobile" || c === "landline"
    ),
    naturezaPrefixes: strArray(t.naturezaPrefixes, "targeting.naturezaPrefixes", 8, 4),
    excludeMei: bool(t.excludeMei),
    matrizOnly: bool(t.matrizOnly, true),
    minCapitalSocial: optNum(t.minCapitalSocial, 0, 1e12),
    minAgeYears: optNum(t.minAgeYears, 0, 200),
    maxAgeYears: optNum(t.maxAgeYears, 0, 200),
    requireNomeFantasia: bool(t.requireNomeFantasia),
  };
}

function parseProbes(v: unknown): Probe[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Probe[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const key = optStr(raw.key, 40)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const terms = strArray(raw.terms, "probe.terms", LIMITS.maxProbeTerms, 60);
    if (!key || seen.has(key) || terms.length === 0) continue;
    seen.add(key);
    out.push({
      key,
      label: optStr(raw.label, 80) ?? key,
      terms,
      meaning: raw.meaning === "negative" ? "negative" : "positive",
      weight: optNum(raw.weight, 0, 10) ?? 1,
    });
    if (out.length >= LIMITS.maxProbes) break;
  }
  return out;
}

const ANCHOR_KEYS = ["1", "2", "3", "4", "5"] as const;

/**
 * Sibling field names, refused as recommendation values.
 *
 * Observed in the wild: asked for a rubric, the compiler put `notes`, `hookBad`
 * and `hookGood` INTO the recommendations list instead of into their own
 * fields. The scoring schema builds its `recommendation` enum from this list,
 * so the scorer then dutifully answered "hookgood" as its recommended action.
 * Dropping these falls back to the sane default pair below.
 */
const RESERVED_RECOMMENDATIONS = new Set([
  "notes",
  "hookbad",
  "hookgood",
  "hook_bad",
  "hook_good",
  "axes",
  "probes",
  "targeting",
  "rubric",
  "summary",
  "buyer",
  "problem",
  "sitesignals",
  "site_signals",
]);

function parseAxes(v: unknown): Axis[] {
  if (!Array.isArray(v)) throw new SpecError("rubric.axes: esperava uma lista");
  const out: Axis[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const key = optStr(raw.key, 40)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const anchorsRaw = isRecord(raw.anchors) ? raw.anchors : null;
    if (!key || !anchorsRaw) continue;
    // Every level must be described. A missing anchor is what turns a 1-5 scale
    // back into the model's private opinion of what "4" means.
    const anchors = {} as Axis["anchors"];
    let complete = true;
    for (const k of ANCHOR_KEYS) {
      const a = optStr(anchorsRaw[k], 200);
      if (!a) {
        complete = false;
        break;
      }
      anchors[k] = a;
    }
    if (!complete) continue;
    out.push({
      key,
      label: optStr(raw.label, 80) ?? key,
      question: str(raw.question, `rubric.axes.${key}.question`),
      anchors,
    });
    if (out.length >= LIMITS.maxAxes) break;
  }
  if (out.length === 0) throw new SpecError("rubric.axes: nenhum eixo válido");
  return out;
}

function parseRubric(v: unknown): Rubric {
  const r = isRecord(v) ? v : {};
  const recs: Recommendation[] = (Array.isArray(r.recommendations) ? r.recommendations : [])
    .filter(isRecord)
    .map((x) => ({
      value:
        optStr(x.value, 40)
          ?.toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_") ?? "",
      label: optStr(x.label, 80) ?? "",
      when: optStr(x.when, 200) ?? "",
    }))
    .filter((x) => x.value && x.label && !RESERVED_RECOMMENDATIONS.has(x.value))
    .slice(0, LIMITS.maxRecommendations);

  return {
    axes: parseAxes(r.axes),
    recommendations: recs.length
      ? recs
      : [
          { value: "abordar", label: "Abordar", when: "encaixa no perfil" },
          { value: "descartar", label: "Descartar", when: "não encaixa" },
        ],
    notes: strArray(r.notes, "rubric.notes", LIMITS.maxNotes),
    siteSignals:
      r.siteSignals === "none" || r.siteSignals === "minimal" ? r.siteSignals : "full",
    hookBad: strArray(r.hookBad, "rubric.hookBad", LIMITS.maxHookExamples),
    hookGood: strArray(r.hookGood, "rubric.hookGood", LIMITS.maxHookExamples),
  };
}

function parseIcpCoverage(v: unknown): IcpCriterion[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .map((x) => ({
      criterion: optStr(x.criterion, LIMITS.maxCriterionLen) ?? "",
      mapped: bool(x.mapped),
      mappedTo: optStr(x.mappedTo, LIMITS.maxCriterionLen) ?? "",
    }))
    .filter((x) => x.criterion)
    .slice(0, LIMITS.maxIcpCriteria);
}

export function parseProjectSpec(input: unknown): ProjectSpec {
  if (!isRecord(input)) throw new SpecError("spec: esperava um objeto");
  return {
    schemaVersion: 1,
    summary: str(input.summary, "summary"),
    buyer: str(input.buyer, "buyer"),
    problem: str(input.problem, "problem"),
    targeting: parseTargeting(input.targeting),
    probes: parseProbes(input.probes),
    rubric: parseRubric(input.rubric),
    icpCoverage: parseIcpCoverage(input.icpCoverage),
  };
}

/**
 * The tier is derived here, never asked of the model.
 *
 * Letting the model emit "hot" alongside the scores means the two can disagree,
 * and then there is no fact of the matter about which one the UI should show.
 */
export function tierFor(fits: Record<string, number | null>): "hot" | "warm" | "cold" | null {
  const best = bestFit(fits);
  if (best === null) return null;
  if (best >= 5) return "hot";
  if (best === 4) return "warm";
  return "cold";
}

export function bestFit(fits: Record<string, number | null>): number | null {
  const values = Object.values(fits).filter((v): v is number => typeof v === "number");
  return values.length ? Math.max(...values) : null;
}
