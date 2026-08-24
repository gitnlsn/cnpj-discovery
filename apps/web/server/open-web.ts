import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  buildDiscoveryQueries,
  classifyWebLeadVerdict,
  crawlSite,
  discoveryQuery,
  HostThrottle,
  parsePlaceAddress,
  parseProjectSpec,
  scoreCompanies,
  verifyMirrorLink,
  type ProjectSpec,
  type ScoreCandidate,
  type SiteSignals,
} from "@cnpj/core";
import {
  findByAddress,
  findByEmailDomain,
  listCompaniesByCnpj,
  type Company,
} from "@cnpj/data";
import {
  cnaePicks,
  companies,
  projects,
  webLeadScores,
  webLeads,
  webQueries,
  type Db,
} from "@cnpj/db";
import { startJob, type JobContext } from "@cnpj/jobs";
import { requireLlm } from "../lib/llm";
import {
  openSource,
  describeTally,
  ENGINE_YIELD,
  type Candidate,
  type DiscoveryEngine,
  type DiscoverySource,
} from "./open-web-sources";
import { siteFromSignals, hasReadableContent } from "./candidate";

/**
 * The open-internet sweep: one job, four phases.
 *
 * One job rather than three chained ones because `jobs_one_running_idx` allows a
 * single run per lane, so a client starting phase two would deadlock on the phase
 * one that is still finishing. Same reason `reprocessMei` chains inside itself.
 *
 * The phase ORDER is what makes this affordable, and it follows directly from what
 * the Places API costs. One call returns up to twenty businesses complete with
 * their website, so discovery is cheap; the crawl and the model call are not. So
 * dedup runs BEFORE either of them, and the expensive half is spent only on
 * businesses the project could not already reach.
 *
 * Runs in the `openweb` lane, so it can proceed while the Empresas tab works.
 */

export interface OpenWebInput {
  projectId: string;
  /** Which engine looks for businesses. See `DiscoveryEngine`. */
  engine: DiscoveryEngine;
  /**
   * How many engine calls this sweep may spend.
   *
   * Counted in CALLS, not queries, because pagination spends the same budget: a
   * second page of one query is a second billed call. Calling it "queries" would
   * make the number lie the moment `pagesPerQuery` is above 1.
   */
  maxQueries: number;
  /**
   * Pages per query, for engines that paginate. Each is a billed call.
   *
   * 20 results per call is Google's cap on Places, so this is the only way past it
   * that does not require inventing more geography — and inventing geography is
   * what narrows each query's reach.
   */
  pagesPerQuery?: number;
  /**
   * Ask nationally rather than city by city.
   *
   * Worth being a choice: the places a sweep uses come from the project's OWN
   * companies, so left alone it can only ever find businesses where the project
   * has already been looking — the opposite of what discovery is for.
   */
  nationwide?: boolean;
  /** Pages beyond the homepage for each crawl. 0 keeps it to the homepage. */
  depth: number;
  /** Crawl the sites of the leads worth keeping. Off makes this a measurement run. */
  crawl: boolean;
  /** Score the unmatched leads. Requires `crawl` — an unread page has nothing to judge. */
  score: boolean;
}

export async function runOpenWebDiscovery(
  db: Db,
  input: OpenWebInput
): Promise<{ jobId: number }> {
  const job = startJob(db, "openweb", input.projectId, async (ctx) => {
    const source = openSource(db, input.engine, { pagesPerQuery: input.pagesPerQuery });
    if ("error" in source) throw new Error(source.error);

    try {
      const plan = await planSweep(db, input, ctx);
      if (!plan) return;

      const found = await discover(db, input, ctx, source, plan);
      if (!found.candidates.length) {
        ctx.log("nenhum negócio novo veio das consultas.");
        return;
      }

      const leads = await dedup(db, input, ctx, plan.spec, found);
      if (input.crawl) await crawlLeads(db, input, ctx, leads);
      if (input.crawl && input.score) await scoreLeads(db, input, ctx, plan.spec, leads);
    } finally {
      // Google through the real browser holds a Chrome open; the others are no-ops.
      await source.close();
    }
  });
  return { jobId: job.id };
}

// --------------------------------------------------------------------- phase 0

interface Plan {
  spec: ProjectSpec;
  queries: { query: string; term: string; place: string }[];
}

/**
 * What the sweep will spend, decided and logged before a cent of quota goes.
 *
 * The plan is printed first because at a couple of dozen calls a month the
 * operator has to be able to read it and disagree. It is also fully deterministic
 * — no model chooses these — so the same project always plans the same sweep.
 */
async function planSweep(db: Db, input: OpenWebInput, ctx: JobContext): Promise<Plan | null> {
  const [project] = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1)
    .all();
  if (!project) throw new Error("projeto não encontrado");

  const spec = parseProjectSpec(project.spec);
  if (!spec) {
    throw new Error(
      "o projeto não tem rubrica compilada — compile o ICP antes de varrer a web"
    );
  }

  const picks = db
    .select()
    .from(cnaePicks)
    .where(and(eq(cnaePicks.projectId, input.projectId), eq(cnaePicks.chosen, true)))
    .all();
  const labels = picks.map((p) => p.descricao).filter((d): d is string => Boolean(d));

  // Geography from the project's own companies, most common first: it is where
  // this project has actually been looking, which beats guessing from the UF.
  const rows = db
    .select({ municipio: companies.municipio, uf: companies.uf })
    .from(companies)
    .where(eq(companies.projectId, input.projectId))
    .all();
  const tally = new Map<string, number>();
  for (const r of rows) {
    if (!r.municipio || !r.uf) continue;
    const key = `${r.municipio} ${r.uf}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const places = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  // Fewer distinct queries when paginating, because the call budget is shared:
  // three pages of one query cost what three queries cost.
  const pages = Math.min(Math.max(input.pagesPerQuery ?? 1, 1), 3);
  const queries = buildDiscoveryQueries({
    spec,
    cnaeLabels: labels,
    places,
    max: Math.max(1, Math.floor(input.maxQueries / pages)),
    nationwide: input.nationwide,
  });
  if (!queries.length) {
    throw new Error(
      "nada para consultar: escolha CNAEs no projeto, ou compile um ICP com termos positivos"
    );
  }

  ctx.log(
    `plano · ${input.engine} · ${queries.length} consulta(s) × ${pages} página(s) = até ` +
      `${queries.length * pages} chamadas, cada uma devolvendo até ` +
      `${ENGINE_YIELD[input.engine]} resultados` +
      (input.nationwide ? " · sem recorte de cidade" : "") +
      ":"
  );
  for (const q of queries) ctx.log(`  ${discoveryQuery(q.term, q.place)}`);
  ctx.progress({ done: 0, total: queries.length, note: "planejado" });
  return { spec, queries };
}

// --------------------------------------------------------------------- phase 1

/** A business as it arrived, before we know anything about its CNPJ. */
interface Found extends Candidate {
  queryId: number;
}

interface Discovered {
  candidates: Found[];
  /** CNPJs harvested from registry mirrors, unattributed. See `FetchResult`. */
  cnpjHints: string[];
}

/**
 * Ask the engine, keep what could be a business, record that we asked.
 *
 * A business with no website is dropped and not stored. That is not an oversight:
 * the premise is finding companies WITH a site that the Receita query never
 * reached, and without one there is nothing to crawl, nothing to score, and
 * nothing to key the row on.
 */
async function discover(
  db: Db,
  input: OpenWebInput,
  ctx: JobContext,
  source: DiscoverySource,
  plan: Plan
): Promise<Discovered> {
  const out: Found[] = [];
  const hints = new Set<string>();
  const seen = new Set<string>(
    db
      .select({ apex: webLeads.apex })
      .from(webLeads)
      .where(eq(webLeads.projectId, input.projectId))
      .all()
      .map((r) => r.apex)
  );

  const budget = { left: input.maxQueries };
  for (const planned of plan.queries) {
    if (ctx.cancelled() || budget.left <= 0) break;
    const query = discoveryQuery(planned.term, planned.place);
    if (!query) continue;

    const spentBefore = budget.left;
    const result = await source.fetch(query, budget);
    for (const cnpj of result.cnpjHints) hints.add(cnpj);

    const fresh: Found[] = [];
    for (const candidate of result.candidates) {
      // The source dedups within its own pages; this catches apexes an EARLIER
      // query or an earlier sweep already stored.
      if (seen.has(candidate.apex)) {
        result.dropped.alreadySeen++;
        continue;
      }
      seen.add(candidate.apex);
      fresh.push({ ...candidate, queryId: 0 });
    }

    // The record of having asked, written only because we WERE answered. A
    // refusal leaves no row at all — a row would claim we looked when we were
    // turned away, which is the invariant `search_lookups` exists to protect.
    if (spentBefore !== budget.left) {
      const [row] = db
        .insert(webQueries)
        .values({
          projectId: input.projectId,
          query,
          provider: source.engine,
          considered: result.considered,
          kept: fresh.length,
        })
        .returning({ id: webQueries.id })
        .all();
      for (const f of fresh) out.push({ ...f, queryId: row?.id ?? 0 });
      // The breakdown, because the two numbers alone cannot be argued with:
      // "10 vistos · 2 novos" looks the same whether the gates are working or
      // eating everything, and NONE of these drops is dedup against the Receita
      // — that happens later and its answer is the verdict.
      ctx.log(
        `"${query}" · ${result.considered} vistos · ${fresh.length} novos · ` +
          `descartados: ${describeTally(result.dropped)}`
      );
    }

    ctx.progress({
      done: input.maxQueries - budget.left,
      total: input.maxQueries,
      note: `${out.length} novos`,
    });

    if (result.stop) {
      ctx.log(`parei nas consultas: ${result.stop}`);
      break;
    }
  }

  ctx.log(
    `chamadas gastas: ${input.maxQueries - budget.left} · negócios novos com site: ${out.length}` +
      (hints.size ? ` · ${hints.size} CNPJs vistos em espelhos de cadastro` : "")
  );
  return { candidates: out, cnpjHints: [...hints] };
}

// --------------------------------------------------------------------- phase 2

interface Lead {
  apex: string;
  websiteUrl: string;
  verdict: "in_reach" | "out_of_reach" | "unmatched";
}

/**
 * Which of these businesses the Receita already knows, and which the project
 * could already reach.
 *
 * The address route runs first and in ONE batch, because it is the only bridge
 * that works for the majority: the Receita has no website column, and its
 * registered e-mail is a free-mail address for roughly nine in ten
 * micro-businesses.
 *
 * Google's name and address are used HERE and go no further. Neither is written to
 * `web_leads` — the terms permit the `place_id` and nothing else, and the name the
 * screen eventually shows comes from our own crawl.
 */
async function dedup(
  db: Db,
  input: OpenWebInput,
  ctx: JobContext,
  spec: ProjectSpec,
  found: Discovered
): Promise<Lead[]> {
  const matched = new Map<string, Company>();
  const via = new Map<string, "address" | "email_domain" | "mirror">();
  let ambiguous = 0;

  /** Believe a pairing only when the registry's own name backs it. */
  const claim = (
    candidate: Found,
    company: Company,
    how: "address" | "email_domain" | "mirror"
  ): boolean => {
    if (matched.has(candidate.apex)) return false;
    if (
      !verifyMirrorLink({ siteUrl: candidate.websiteUrl, siteTitle: candidate.name, company })
    ) {
      return false;
    }
    matched.set(candidate.apex, company);
    via.set(candidate.apex, how);
    return true;
  };

  // --- route 1: the address. Places only, and the strongest of the three.
  const probes: {
    ref: string;
    logradouro: string;
    numero: string | null;
    uf: string | null;
  }[] = [];
  const byApex = new Map(found.candidates.map((c) => [c.apex, c]));
  for (const candidate of found.candidates) {
    const parsed = parsePlaceAddress(candidate.address);
    if (!parsed?.logradouro) continue;
    probes.push({
      ref: candidate.apex,
      logradouro: parsed.logradouro,
      numero: parsed.numero,
      uf: parsed.uf,
    });
  }
  for (const lookup of probes.length ? await findByAddress(probes) : []) {
    const candidate = byApex.get(lookup.ref);
    if (!candidate) continue;
    if (lookup.ambiguous) ambiguous++;
    // Several companies at one address is a building, not a business. The name is
    // what closes that gap, and it is the same decision `verifyMirrorLink` makes.
    for (const company of lookup.companies) if (claim(candidate, company, "address")) break;
  }

  // --- route 2: the registered e-mail domain. Works for every engine, and is the
  // only route an organic result has besides the mirrors — but recall is low by
  // construction, since most micro-businesses registered a free-mail address.
  const unresolved = found.candidates.filter((c) => !matched.has(c.apex));
  if (unresolved.length) {
    const companies = await findByEmailDomain(unresolved.map((c) => c.apex));
    const byDomain = new Map<string, Company[]>();
    for (const company of companies) {
      const domain = (company.email ?? "").split("@")[1]?.toLowerCase();
      if (!domain) continue;
      const list = byDomain.get(domain) ?? [];
      list.push(company);
      byDomain.set(domain, list);
    }
    for (const candidate of unresolved) {
      for (const company of byDomain.get(candidate.apex) ?? []) {
        if (claim(candidate, company, "email_domain")) break;
      }
    }
  }

  // --- route 3: the CNPJs the registry mirrors handed over.
  //
  // The trap, restated because it is the expensive one: a mirror sits in the same
  // result set as the businesses and NOTHING connects them. It may be about the
  // third result down. So every hint is looked up and then offered to every
  // still-unmatched candidate, and only the name decides.
  if (found.cnpjHints.length) {
    const still = found.candidates.filter((c) => !matched.has(c.apex));
    if (still.length) {
      const companies = await listCompaniesByCnpj(found.cnpjHints.slice(0, 200));
      let paired = 0;
      for (const candidate of still) {
        for (const company of companies)
          if (claim(candidate, company, "mirror")) {
            paired++;
            break;
          }
      }
      if (paired) ctx.log(`${paired} CNPJ(s) de espelho casaram com o nome do site`);
    }
  }

  const targeting = {
    cnaePrefixes: spec.targeting?.cnaePrefixes ?? [],
    cnaeExclude: spec.targeting?.cnaeExclude ?? [],
    ufs: spec.targeting?.ufs ?? [],
  };

  const leads: Lead[] = [];
  const tally = { in_reach: 0, out_of_reach: 0, unmatched: 0 };
  for (const candidate of found.candidates) {
    const company = matched.get(candidate.apex) ?? null;
    const { verdict, by } = classifyWebLeadVerdict({
      company: company ? { cnae: company.cnae, uf: company.uf } : null,
      targeting,
    });
    tally[verdict]++;

    db.insert(webLeads)
      .values({
        projectId: input.projectId,
        apex: candidate.apex,
        websiteUrl: candidate.websiteUrl,
        placeId: candidate.placeId,
        queryId: candidate.queryId || null,
        verdict,
        outOfReachBy: by,
        matchedCnpj: company?.cnpj ?? null,
        matchVia: company ? (via.get(candidate.apex) ?? "address") : null,
        matchedCnae: company?.cnae ?? null,
      })
      .onConflictDoNothing()
      .run();

    leads.push({ apex: candidate.apex, websiteUrl: candidate.websiteUrl, verdict });
  }

  ctx.log(
    `dedup · ${tally.in_reach} já na base dentro do seu CNAE · ` +
      `${tally.out_of_reach} na base FORA do seu alcance · ` +
      `${tally.unmatched} sem CNPJ que a gente conseguisse achar` +
      (ambiguous ? ` · ${ambiguous} endereços de prédio, não dá para escolher` : "")
  );
  return leads;
}

// --------------------------------------------------------------------- phase 3

/**
 * Crawl the leads worth reading.
 *
 * `in_reach` is skipped: the project's own query already returns that company, so
 * a crawl here would pay for a page the Empresas tab can fetch itself.
 */
async function crawlLeads(
  db: Db,
  input: { projectId: string; depth: number; maxPages?: number },
  ctx: JobContext,
  leads: Lead[]
): Promise<void> {
  const worth = leads.filter((l) => l.verdict !== "in_reach");
  if (!worth.length) return;

  const throttle = new HostThrottle(1000);
  let done = 0;
  let withContact = 0;
  for (const lead of worth) {
    if (ctx.cancelled()) break;
    // A lead with no CNPJ is reached ONLY through its own site, so it gets the
    // deep walk: the contact address is the deliverable, and it is regularly two
    // clicks in behind a menu the shallow crawl never opens.
    const unmatched = lead.verdict === "unmatched";
    const signals: SiteSignals = await crawlSite(lead.websiteUrl, {
      depth: unmatched ? Math.max(input.depth, 3) : input.depth,
      maxPages: unmatched ? (input.maxPages ?? 15) : undefined,
      // The 8-second default is tuned for reading a home page, and it was losing
      // whole sites: `trisul-sa.com.br` timed out with nothing. A slow shared host
      // is common here, and for a lead whose only handle is its own site, waiting
      // is cheaper than never having the contact.
      timeoutMs: unmatched ? 20_000 : undefined,
      throttle,
    });
    if (signals.emails.length || signals.phones.length) withContact++;
    db.update(webLeads)
      .set({
        finalUrl: signals.finalUrl,
        httpStatus: signals.httpStatus,
        crawlError: signals.error,
        signals,
        textExcerpt: signals.textExcerpt?.slice(0, 8000) ?? null,
        pagesFetched: signals.pagesFetched,
        // The deliverable for a lead with no CNPJ. Written even when empty, so
        // "we read the site and it lists no contact" is a recorded fact.
        emails: signals.emails,
        phones: signals.phones,
        // Set even on a failure: "we looked and could not read it" must stay
        // distinguishable from "nobody looked".
        crawledAt: new Date().toISOString(),
      })
      .where(and(eq(webLeads.projectId, input.projectId), eq(webLeads.apex, lead.apex)))
      .run();
    done++;
    ctx.progress({ done, total: worth.length, note: "lendo os sites" });
  }
  ctx.log(`crawl · ${done} sites lidos · ${withContact} com e-mail ou telefone na página`);
}

// --------------------------------------------------------------------- phase 4

/**
 * Score the leads that have no CNPJ, with the project's own rubric.
 *
 * Only the unmatched ones. An `out_of_reach` lead has a CNPJ, so it belongs in
 * `companies` where every existing verb already works on it — scoring it here
 * would produce a second, divergent opinion in a table nothing else reads.
 */
async function scoreLeads(
  db: Db,
  input: OpenWebInput,
  ctx: JobContext,
  spec: ProjectSpec,
  leads: Lead[]
): Promise<void> {
  const apexes = leads.filter((l) => l.verdict === "unmatched").map((l) => l.apex);
  if (!apexes.length) return;

  const rows = db
    .select()
    .from(webLeads)
    .where(and(eq(webLeads.projectId, input.projectId), inArray(webLeads.apex, apexes)))
    .all();

  await scoreWebLeadRows(db, input.projectId, ctx, spec, rows);
}

/** The scoring half, shared by the sweep and by `rescoreWebLeads`. */
async function scoreWebLeadRows(
  db: Db,
  projectId: string,
  ctx: JobContext,
  spec: ProjectSpec,
  rows: (typeof webLeads.$inferSelect)[]
): Promise<void> {
  const candidates: ScoreCandidate[] = [];
  for (const row of rows) {
    const signals = row.signals as SiteSignals | null;
    const site = signals ? siteFromSignals(signals) : null;
    // An unreadable page has nothing to judge, and spending a model call to be
    // told "cannot_determine" is spending it to learn nothing.
    if (!hasReadableContent(site)) continue;
    candidates.push({
      id: row.apex,
      cnpj: null,
      razaoSocial: null,
      // The only name we are entitled to keep: the one our own crawl read.
      nomeFantasia: signals?.title ?? row.apex,
      cnae: "",
      cnaeDescricao: null,
      uf: null,
      municipio: null,
      dataInicioAtividade: null,
      porte: null,
      mei: false,
      site,
    });
  }

  if (!candidates.length) {
    ctx.log("nenhum lead sem CNPJ teve página legível — nada para pontuar.");
    return;
  }

  // One call site, one batch loop inside `scoreCompanies` — no reason for the
  // lazy singleton `continuous.ts` needs, where the port has to remember its
  // pacing across a long walk.
  const results = await scoreCompanies(requireLlm(), spec, candidates, {
    keyField: "ref",
    withWebLead: true,
    batchSize: 10,
    onProgress: (done, total) => ctx.progress({ done, total, note: "pontuando" }),
  });

  for (const r of results) {
    const row = {
      fits: r.fits,
      bestFit: r.bestFit,
      tier: r.tier,
      confidence: r.confidence,
      recommendation: r.recommendation,
      wrongType: r.wrongType,
      hook: r.hook,
      advice: r.advice,
      evidence: r.evidence,
      model: r.model,
      promptSha: r.promptSha,
      error: r.error,
      scoredAt: new Date().toISOString(),
    };
    db.insert(webLeadScores)
      .values({ projectId, apex: r.id, ...row })
      .onConflictDoUpdate({
        target: [webLeadScores.projectId, webLeadScores.apex],
        set: row,
      })
      .run();
  }

  const scored = results.filter((r) => !r.error).length;
  ctx.log(`pontuação · ${scored} de ${results.length} leads sem CNPJ receberam nota`);
}

/**
 * Scores web leads that have no score yet, without spending an engine call.
 *
 * Separate from the sweep on purpose. A rerun of the sweep would pay Places or the
 * SERP budget to rediscover businesses already sitting in `web_leads` — and the
 * common reason a lead has no score is that the model's daily quota ran out, which
 * has nothing to do with the search. This is the cheap half on its own.
 */
export async function rescoreWebLeads(
  db: Db,
  projectId: string,
  onlyFailed: boolean
): Promise<{ jobId: number }> {
  const job = startJob(db, "openweb", projectId, async (ctx) => {
    const [project] = db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .all();
    const spec = parseProjectSpec(project?.spec);
    if (!spec) throw new Error("o projeto não tem rubrica compilada");

    const rows = db
      .select()
      .from(webLeads)
      .leftJoin(
        webLeadScores,
        and(
          eq(webLeadScores.projectId, webLeads.projectId),
          eq(webLeadScores.apex, webLeads.apex)
        )
      )
      .where(and(eq(webLeads.projectId, projectId), eq(webLeads.verdict, "unmatched")))
      .all();

    const pending = rows.filter((r) => {
      const score = r.web_lead_scores;
      if (!score) return true;
      // `onlyFailed` keeps a rerun from re-spending on leads already graded.
      return onlyFailed ? Boolean(score.error) : true;
    });

    if (!pending.length) {
      ctx.log("nada para pontuar: todos os leads sem CNPJ já têm nota.");
      return;
    }

    ctx.log(`pontuando ${pending.length} lead(s) sem CNPJ`);
    await scoreWebLeadRows(
      db,
      projectId,
      ctx,
      spec,
      pending.map((r) => r.web_leads)
    );
  });
  return { jobId: job.id };
}

/**
 * Re-reads the sites of leads already stored, without spending an engine call.
 *
 * Needed because a crawl is only as good as the code that ran it: every lead
 * found before contact extraction existed has an empty `emails` and `phones`,
 * which on this tab is the deliverable missing. Re-running the sweep instead
 * would pay Places or the SERP budget to rediscover businesses already in the
 * table.
 */
export async function recrawlWebLeads(
  db: Db,
  projectId: string,
  opts: { onlyWithoutContact: boolean; depth: number; maxPages?: number }
): Promise<{ jobId: number }> {
  const job = startJob(db, "openweb", projectId, async (ctx) => {
    const rows = db
      .select()
      .from(webLeads)
      .where(and(eq(webLeads.projectId, projectId), isNull(webLeads.discardedAt)))
      .all();

    const pending = rows.filter((r) => {
      if (r.verdict === "in_reach") return false;
      if (!opts.onlyWithoutContact) return true;
      const emails = r.emails ?? [];
      const phones = r.phones ?? [];
      // Never crawled, or crawled by a version that could not read contacts.
      return !r.crawledAt || (emails.length === 0 && phones.length === 0);
    });

    if (!pending.length) {
      ctx.log("nada para reler: todos os leads já têm contato ou já foram lidos.");
      return;
    }

    ctx.log(
      `relendo ${pending.length} site(s) · até ${opts.maxPages ?? 15} páginas cada, ` +
        `seguindo os links internos`
    );
    await crawlLeads(
      db,
      { projectId, depth: opts.depth, maxPages: opts.maxPages },
      ctx,
      pending.map((r) => ({ apex: r.apex, websiteUrl: r.websiteUrl, verdict: r.verdict }))
    );
  });
  return { jobId: job.id };
}
