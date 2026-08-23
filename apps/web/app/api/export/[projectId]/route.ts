import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { getDb, leads, companies, scores, crawls, contacts } from "@cnpj/db";
import { formatCsvForExcel, formatAddress, formatCep } from "@cnpj/core";

/**
 * The companies list as a CSV.
 *
 * A route handler rather than a tRPC procedure because the browser has to be
 * able to just follow a link and get a file — tRPC would hand back a JSON
 * string the page would then have to turn into a download itself.
 *
 * It exports what the screen is showing, so it reads the same query params the
 * companies view filters by. Anything the lead table adds (status, notes) is a
 * column, not a condition: a company that was never flagged still belongs in
 * the file, with those cells empty.
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
  "endereco",
  "logradouro",
  "numero",
  "complemento",
  "cep",
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

const LEAD_STATUSES = ["flagged", "contacted", "replied", "won", "lost"];

/** "sim"/"nao" from the UI; anything else means the filter is off. */
function tri(v: string | null): boolean | undefined {
  return v === "sim" ? true : v === "nao" ? false : undefined;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const sp = new URL(req.url).searchParams;
  // Repeated `flag`, one per lead state to keep; empty means all of them.
  // `status`/`any` are the older single-value spelling and still work.
  const flags = sp.getAll("flag").flatMap((f) => (f === "any" ? LEAD_STATUSES : [f]));
  const legacy = sp.get("status");
  if (legacy && !flags.length) flags.push(...(legacy === "any" ? LEAD_STATUSES : [legacy]));
  const q = sp.get("q")?.toLowerCase() || undefined;
  const cnae = sp.get("cnae") || undefined;
  const uf = sp.get("uf")?.toUpperCase() || undefined;
  const crawled = tri(sp.get("crawled"));
  // Same default as the screen: only companies that made it through scoring,
  // unless the caller asks for the pending ones or for everything.
  const situacao = sp.get("situacao") ?? "";
  const processed = situacao === "todas" ? undefined : situacao !== "nao";
  const order = sp.get("order") ?? "score";
  const db = getDb();

  const rows = await db
    .select()
    .from(companies)
    .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
    .leftJoin(
      scores,
      and(eq(scores.cnpj, companies.cnpj), eq(scores.projectId, companies.projectId))
    )
    .leftJoin(
      leads,
      and(eq(leads.cnpj, companies.cnpj), eq(leads.projectId, companies.projectId))
    )
    .where(eq(companies.projectId, projectId))
    .orderBy(
      order === "founded"
        ? desc(companies.dataInicioAtividade)
        : order === "name"
          ? asc(companies.nomeFantasia)
          : desc(scores.bestFit)
    );

  const filtered = rows.filter((r) => {
    const c = r.companies;
    if (cnae && !c.cnae.startsWith(cnae)) return false;
    if (uf && c.uf !== uf) return false;
    if (q) {
      const hay = `${c.nomeFantasia ?? ""} ${c.razaoSocial ?? ""} ${c.cnpj}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (flags.length && !flags.includes(r.leads?.status ?? "none")) return false;
    if (crawled === true && !r.crawls) return false;
    if (crawled === false && r.crawls) return false;
    if (processed === true && !r.scores) return false;
    if (processed === false && r.scores) return false;
    return true;
  });

  const phones = filtered.length
    ? await db
        .select()
        .from(contacts)
        .where(
          inArray(
            contacts.cnpj,
            filtered.map((r) => r.companies.cnpj)
          )
        )
    : [];

  const body = filtered.map((r) => {
    // Prefer the number found on the company's own site: the one filed with the
    // Receita is frequently the accountant's line.
    const phone =
      phones.find((p) => p.cnpj === r.companies.cnpj && p.source === "site") ??
      phones.find((p) => p.cnpj === r.companies.cnpj);
    const c = r.companies;
    return [
      c.cnpj,
      c.razaoSocial ?? "",
      c.nomeFantasia ?? "",
      c.cnae ?? "",
      c.cnaeDescricao ?? "",
      c.municipio ?? "",
      c.uf ?? "",
      c.bairro ?? "",
      // The composed line first, because that is the one a person pastes into
      // Maps; the raw columns after it, for a mail merge that needs the parts.
      formatAddress(c) ?? "",
      c.logradouro ?? "",
      c.numero ?? "",
      c.complemento ?? "",
      formatCep(c.cep) ?? "",
      c.dataInicioAtividade ?? "",
      c.porte ?? "",
      c.mei ? "sim" : "nao",
      c.email ?? "",
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
      r.leads?.status ?? "",
      r.leads?.notes ?? "",
      r.leads?.flaggedAt ?? "",
      r.leads?.contactedAt ?? "",
    ];
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(formatCsvForExcel(HEADER, body), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="empresas-${projectId}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const dynamic = "force-dynamic";
