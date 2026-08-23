import { eq } from "drizzle-orm";
import { companies, crawls, scores, contacts, projects, type Db } from "@cnpj/db";
import { startJob } from "@cnpj/jobs";
import { listCompanies, type CompanyFilters, type CompanyOrder } from "@cnpj/data";
import {
  crawlSite,
  websiteFromEmail,
  classifyReceitaPhone,
  buildWaMeLink,
  parseProjectSpec,
  scoreCompanies,
  HostThrottle,
  type ProjectSpec,
  classifyRateLimit,
  backoffMs,
  dailyLimitAdvice,
  type ScoreCandidate,
  type SiteSignals,
  type LlmPort,
} from "@cnpj/core";
import { requireLlm, provider } from "../lib/llm";
import { recordLlm, remainingToday, dailyLimit } from "../lib/llm-budget";
import {
  siteFromSignals,
  toScoreCandidate,
  hasReadableContent,
  loadPresence,
} from "./candidate";

/**
 * Takes one company at a time from the base and runs it all the way through,
 * until you stop it or a stopping condition is hit.
 *
 * One at a time, deliberately. A batch of ten is cheaper per company, but this
 * job is meant to be watched and interrupted — with batching, stopping would
 * throw away up to nine companies' work, and the count on screen would lurch
 * instead of ticking.
 *
 * It stops on its own for four reasons, and says which:
 *   · you pressed stop
 *   · the filters ran out of companies
 *   · the daily model budget is spent
 *   · the model failed repeatedly, which usually means a rate limit
 */
/**
 * How many transient rate-limit waits to sit through before giving up.
 *
 * Generous on purpose. A per-minute ceiling recovers within a minute, so
 * quitting after three was throwing away a run that only needed to wait — the
 * loop ended after a few dozen companies when it could have kept going. The
 * daily cap is handled separately and stops immediately, because no amount of
 * waiting fixes it before tomorrow.
 */
const MAX_TRANSIENT_WAITS = 8;
/** Failures that are not rate limits — a broken key, a bad schema. */
const MAX_HARD_FAILURES = 3;

/** A sleep that notices when you press stop. */
async function pausableSleep(ms: number, cancelled: () => boolean): Promise<void> {
  const step = 1000;
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelled()) return;
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

export interface ContinuousInput {
  projectId: string;
  filters: CompanyFilters;
  order: CompanyOrder;
  depth: number;
  sourcePeriod?: string;
}

export async function runContinuous(
  db: Db,
  input: ContinuousInput
): Promise<{ jobId: number }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
  let spec: ProjectSpec | null = null;
  try {
    spec = project?.spec ? parseProjectSpec(project.spec) : null;
  } catch {
    spec = null;
  }

  const job = startJob(db, "continuous", input.projectId, async (ctx) => {
    // Seeded once and grown as we go: re-reading the project's CNPJs on every
    // iteration would be a query per company for a list only this loop changes.
    const seen = new Set(
      (
        await db
          .select({ cnpj: companies.cnpj })
          .from(companies)
          .where(eq(companies.projectId, input.projectId))
      ).map((r) => r.cnpj)
    );

    const throttle = new HostThrottle(1000);
    // Built at most once, on purpose. The client spaces its own calls to stay
    // under the provider's per-minute ceiling, and it does that by remembering
    // when it last called — so rebuilding it per company (as this used to)
    // resets that memory every time and the spacing never happens. Lazy so a
    // run without a key still crawls instead of dying at the first line.
    let port: LlmPort | null = null;
    const llmPort = () => (port ??= requireLlm());
    let done = 0;
    let scored = 0;
    let noSite = 0;
    let transientWaits = 0;
    let hardFailures = 0;
    let stopped = "você mandou parar";

    ctx.log(
      `contínuo iniciado · ${await remainingToday(db)} de ${dailyLimit()} requisições restantes hoje`
    );

    while (!ctx.cancelled()) {
      if (spec && (await remainingToday(db)) <= 0) {
        stopped = `o teto de ${dailyLimit()} requisições ao modelo por dia acabou`;
        break;
      }

      // One company: the next best match that is not already in the project.
      const [next] = await listCompanies({
        filters: { ...input.filters, excludeCnpjs: [...seen].slice(0, 5000) },
        order: input.order,
        limit: 1,
      });
      if (!next) {
        stopped = "os filtros não têm mais empresas";
        break;
      }
      seen.add(next.cnpj);

      await db
        .insert(companies)
        .values({
          projectId: input.projectId,
          cnpj: next.cnpj,
          razaoSocial: next.razaoSocial,
          nomeFantasia: next.nomeFantasia,
          cnae: next.cnae,
          cnaeDescricao: next.cnaeDescricao,
          uf: next.uf,
          municipio: next.municipio,
          bairro: next.bairro,
          dataInicioAtividade: next.dataInicioAtividade,
          porte: next.porte,
          capitalSocial: next.capitalSocial,
          naturezaJuridica: next.naturezaJuridica,
          mei: next.mei,
          simples: next.simples,
          email: next.email,
          sourcePeriod: input.sourcePeriod ?? null,
        })
        .onConflictDoNothing();

      const url = websiteFromEmail(next.email);
      let signals: SiteSignals | null = null;

      if (url) {
        signals = await crawlSite(url, {
          depth: input.depth,
          probes: spec?.probes ?? [],
          throttle,
        });
        const row = {
          websiteUrl: url,
          finalUrl: signals.finalUrl,
          httpStatus: signals.httpStatus,
          error: signals.error,
          urlSource: "email" as const,
          signals,
          textExcerpt: signals.textExcerpt,
          pagesFetched: signals.pagesFetched,
          checkedAt: new Date().toISOString(),
        };
        await db
          .insert(crawls)
          .values({ cnpj: next.cnpj, ...row })
          .onConflictDoUpdate({ target: crawls.cnpj, set: row });

        if (signals.sitePhone) {
          const digits = signals.sitePhone.replace(/^\+55/, "");
          const parsed = classifyReceitaPhone(digits.slice(0, 2), digits.slice(2));
          if (parsed) {
            await db
              .insert(contacts)
              .values({
                cnpj: next.cnpj,
                phoneE164: parsed.e164,
                isMobile: parsed.isMobile,
                source: "site",
                waMe: buildWaMeLink(parsed.e164),
              })
              .onConflictDoNothing();
          }
        }
      }

      const readable = hasReadableContent(signals);

      if (!spec || !readable) {
        // No page read means no evidence; the rubric can only answer
        // "cannot_determine", so the request is not spent.
        noSite++;
        const row = {
          fits: {},
          bestFit: null,
          tier: null,
          confidence: "cannot_determine" as const,
          recommendation: null,
          wrongType: false,
          hook: null,
          advice: spec
            ? "Sem site para ler. Tente o Places para descobrir um, ou descarte."
            : "Perfil do projeto ainda não compilado.",
          evidence: {
            evidence: [],
            justification: spec
              ? "Nenhuma página foi lida, então não há evidência para pontuar. Nenhuma chamada ao modelo foi gasta."
              : "O projeto ainda não tem rubrica compilada.",
          },
          model: null,
          promptSha: null,
          error: null,
          scoredAt: new Date().toISOString(),
        };
        await db
          .insert(scores)
          .values({ projectId: input.projectId, cnpj: next.cnpj, ...row })
          .onConflictDoUpdate({ target: [scores.projectId, scores.cnpj], set: row });
      } else {
        // No impression: this loop only ever scores a company it just pulled
        // from the base, and nobody has laid eyes on it yet. Rescoring one with
        // an impression is the sheet's job, not this loop's.
        const candidate: ScoreCandidate = toScoreCandidate(
          next,
          siteFromSignals(signals!),
          null,
          // Normally empty: this loop scores a company it just pulled from the
          // base. It is populated when the search stage ran over this CNPJ in
          // an earlier session, and there is no reason to throw that away.
          (await loadPresence(db, [next.cnpj])).get(next.cnpj)
        );

        const [result] = await scoreCompanies(llmPort(), spec, [candidate], {
          batchSize: 1,
        });
        await recordLlm(db, 1);

        if (result) {
          const row = {
            fits: result.fits,
            bestFit: result.bestFit,
            tier: result.tier,
            confidence: result.confidence,
            recommendation: result.recommendation,
            wrongType: result.wrongType,
            hook: result.hook,
            advice: result.advice,
            evidence: result.evidence,
            model: result.model,
            promptSha: result.promptSha,
            error: result.error,
            scoredAt: new Date().toISOString(),
          };
          await db
            .insert(scores)
            .values({ projectId: input.projectId, cnpj: next.cnpj, ...row })
            .onConflictDoUpdate({ target: [scores.projectId, scores.cnpj], set: row });

          const limit = classifyRateLimit(result.error);

          if (limit === "daily") {
            stopped = dailyLimitAdvice(provider());
            break;
          }

          if (limit === "transient") {
            // A per-minute ceiling. Wait it out and keep going: this company is
            // left with its error recorded and will be picked up again, because
            // a score row with `error` set is treated as unscored.
            transientWaits++;
            if (transientWaits > MAX_TRANSIENT_WAITS) {
              stopped = `o modelo seguiu limitando depois de ${MAX_TRANSIENT_WAITS} esperas`;
              break;
            }
            const wait = backoffMs(transientWaits);
            ctx.log(
              `limite temporário do modelo · esperando ${Math.round(wait / 1000)}s ` +
                `(${transientWaits}/${MAX_TRANSIENT_WAITS})`
            );
            seen.delete(next.cnpj);
            await pausableSleep(wait, () => ctx.cancelled());
          } else if (result.error) {
            hardFailures++;
            if (hardFailures >= MAX_HARD_FAILURES) {
              stopped = `o modelo falhou ${hardFailures} vezes seguidas: ${result.error.slice(0, 120)}`;
              break;
            }
          } else {
            transientWaits = 0;
            hardFailures = 0;
            scored++;
          }
        }
      }

      done++;
      ctx.progress({
        done,
        // A continuous run has no total. Reporting `done` twice keeps the bar
        // honest instead of inventing a denominator.
        total: done,
        note: `${scored} pontuadas · ${noSite} sem site`,
      });
    }

    ctx.log(
      `parou: ${stopped} · ${done} empresas processadas · ${scored} pontuadas · ${noSite} sem site`
    );
  });

  return { jobId: job.id };
}
