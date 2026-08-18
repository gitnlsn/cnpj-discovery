import { eq, and, desc, inArray } from "drizzle-orm";
import { getDb, leads, companies, scores, crawls, contacts } from "@cnpj/db";
import { formatCsvForExcel } from "@cnpj/core";

/**
 * The flagged list as a CSV.
 *
 * A route handler rather than a tRPC procedure because the browser has to be
 * able to just follow a link and get a file — tRPC would hand back a JSON
 * string the page would then have to turn into a download itself.
 */
const HEADER = [
  "cnpj",
  "razao_social",
  "nome_fantasia",
  "cnae",
  "cnae_descricao",
  "municipio",
  "uf",
  "bairro",
  "data_inicio_atividade",
  "porte",
  "mei",
  "email",
  "telefone",
  "telefone_e_celular",
  "origem_do_telefone",
  "whatsapp",
  "site",
  "nota",
  "tier",
  "confianca",
  "gancho",
  "conselho",
  "status",
  "anotacoes",
  "marcado_em",
  "contatado_em",
] as string[];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const wanted = new URL(req.url).searchParams.get("status");
  const db = getDb();

  const rows = await db
    .select()
    .from(leads)
    .leftJoin(
      companies,
      and(eq(companies.cnpj, leads.cnpj), eq(companies.projectId, leads.projectId))
    )
    .leftJoin(scores, and(eq(scores.cnpj, leads.cnpj), eq(scores.projectId, leads.projectId)))
    .leftJoin(crawls, eq(crawls.cnpj, leads.cnpj))
    .where(eq(leads.projectId, projectId))
    .orderBy(desc(scores.bestFit), desc(leads.flaggedAt));

  const filtered = wanted ? rows.filter((r) => r.leads.status === wanted) : rows;

  const phones = filtered.length
    ? await db
        .select()
        .from(contacts)
        .where(inArray(contacts.cnpj, filtered.map((r) => r.leads.cnpj)))
    : [];

  const body = filtered.map((r) => {
    // Prefer the number found on the company's own site: the one filed with the
    // Receita is frequently the accountant's line.
    const phone =
      phones.find((p) => p.cnpj === r.leads.cnpj && p.source === "site") ??
      phones.find((p) => p.cnpj === r.leads.cnpj);
    const c = r.companies;
    return [
      r.leads.cnpj,
      c?.razaoSocial ?? "",
      c?.nomeFantasia ?? "",
      c?.cnae ?? "",
      c?.cnaeDescricao ?? "",
      c?.municipio ?? "",
      c?.uf ?? "",
      c?.bairro ?? "",
      c?.dataInicioAtividade ?? "",
      c?.porte ?? "",
      c?.mei ? "sim" : "nao",
      c?.email ?? "",
      phone?.phoneE164 ?? "",
      phone ? (phone.isMobile ? "sim" : "nao") : "",
      phone?.source ?? "",
      phone?.waMe ?? "",
      r.crawls?.finalUrl ?? "",
      // A failed score has no number. Empty, never a zero that would sort as if
      // it were a real judgement.
      r.scores?.bestFit == null ? "" : String(r.scores.bestFit),
      r.scores?.tier ?? "",
      r.scores?.confidence ?? "",
      r.scores?.hook ?? "",
      r.scores?.advice ?? "",
      r.leads.status,
      r.leads.notes ?? "",
      r.leads.flaggedAt,
      r.leads.contactedAt ?? "",
    ];
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(formatCsvForExcel(HEADER, body), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${projectId}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const dynamic = "force-dynamic";
