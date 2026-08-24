import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, webLeadScores, webLeads } from "@cnpj/db";
import { formatCsvForExcel } from "@cnpj/core";

/**
 * The open-internet leads as a CSV.
 *
 * A route handler rather than a tRPC procedure for the same reason the companies
 * export is one: the browser has to be able to follow a link and get a file.
 *
 * Its own route rather than a mode of that one, because the two lists are
 * different entities. These rows have no CNPJ — that is what they are for — so
 * half the company columns would be permanently empty, and the columns that matter
 * here (the verdict, the contacts we read off the page) have nowhere to go there.
 *
 * What is NOT in the file: any name or address from Google. The terms permit the
 * `place_id` and nothing else, so the name column carries what OUR crawl read from
 * the page title. Exporting Google's copy of it would move data out of the tool
 * that was never ours to keep.
 */
const HEADER = [
  "site",
  "url",
  "titulo_da_pagina",
  "veredito",
  "fora_do_alcance_por",
  "cnpj_casado",
  "casado_por",
  "cnae_casado",
  "emails",
  "telefones",
  "nota",
  "tier",
  "confianca",
  "ramo_errado",
  "gancho",
  "conselho",
  "status",
  "notas",
  "lido_em",
  "achado_em",
];

const VERDICT_LABEL: Record<string, string> = {
  unmatched: "sem CNPJ na Receita",
  out_of_reach: "na base, fora do CNAE do projeto",
  in_reach: "já na base, dentro do CNAE",
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const url = new URL(request.url);
  const verdict = url.searchParams.get("verdict");
  const status = url.searchParams.get("status");
  const db = getDb();

  const where = [eq(webLeads.projectId, projectId)];
  if (verdict === "unmatched" || verdict === "out_of_reach" || verdict === "in_reach") {
    where.push(eq(webLeads.verdict, verdict));
  }
  if (
    status === "flagged" ||
    status === "contacted" ||
    status === "replied" ||
    status === "won" ||
    status === "lost"
  ) {
    where.push(eq(webLeads.status, status));
  }
  // A discarded lead is left out of the file but not deleted from the table: the
  // export is what the screen shows, and the screen hides them by default.
  if (url.searchParams.get("includeDiscarded") !== "1")
    where.push(isNull(webLeads.discardedAt));

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
    .where(and(...where))
    .orderBy(desc(webLeadScores.bestFit), desc(webLeads.foundAt))
    .limit(5000)
    .all();

  const body = rows.map((r) => {
    const lead = r.web_leads;
    const score = r.web_lead_scores;
    const signals = lead.signals as { title?: string } | null;
    return [
      lead.apex,
      lead.finalUrl ?? lead.websiteUrl,
      signals?.title ?? "",
      VERDICT_LABEL[lead.verdict] ?? lead.verdict,
      lead.outOfReachBy ?? "",
      lead.matchedCnpj ?? "",
      lead.matchVia ?? "",
      lead.matchedCnae ?? "",
      (lead.emails ?? []).join(" · "),
      (lead.phones ?? []).join(" · "),
      score?.bestFit == null ? "" : String(score.bestFit),
      score?.tier ?? "",
      score?.confidence ?? "",
      score?.wrongType ? "sim" : "",
      score?.hook ?? "",
      score?.advice ?? "",
      lead.status ?? "",
      lead.notes ?? "",
      lead.crawledAt ?? "",
      lead.foundAt,
    ];
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(formatCsvForExcel(HEADER, body), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="internet-aberta-${projectId}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const dynamic = "force-dynamic";
