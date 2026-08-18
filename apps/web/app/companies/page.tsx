"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox, NoProject, Num, Tier } from "@/components/bits";
import { BatchBar } from "./BatchBar";
import { AddCompanies } from "./AddCompanies";

const LEAD_LABEL: Record<string, string> = {
  flagged: "marcado",
  contacted: "contatado",
  replied: "respondeu",
  won: "fechou",
  lost: "não deu",
};
const LEAD_CHIP: Record<string, string> = {
  flagged: "chip-plain",
  contacted: "chip-warm",
  replied: "chip-hot",
  won: "chip-hot",
  lost: "chip-bad",
};

/**
 * Every company in the project, with everything known about it.
 *
 * One entity, one screen. Enrichment, scoring and flagging are verbs applied to
 * a selection here rather than separate destinations you navigate between to
 * change which verb is available.
 */
function CompaniesTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [depth, setDepth] = useState(0);
  const [filters, setFilters] = useState<{
    q: string;
    cnae: string;
    uf: string;
    flag: string;
    crawled: string;
    scored: string;
    order: "score" | "founded" | "name";
  }>({ q: "", cnae: "", uf: "", flag: "", crawled: "", scored: "", order: "score" });

  const tri = (v: string) => (v === "" ? undefined : v === "sim");

  const list = useQuery({
    ...trpc.companies.list.queryOptions({
      projectId: projectId ?? "",
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.cnae ? { cnae: filters.cnae } : {}),
      ...(filters.uf.length === 2 ? { uf: filters.uf } : {}),
      ...(filters.flag ? { flag: filters.flag as "any" } : {}),
      ...(tri(filters.crawled) !== undefined ? { crawled: tri(filters.crawled) } : {}),
      ...(tri(filters.scored) !== undefined ? { scored: tri(filters.scored) } : {}),
      order: filters.order,
      limit: 300,
    }),
    enabled: Boolean(projectId),
  });
  const summary = useQuery({
    ...trpc.companies.summary.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });
  const setLeadStatus = useMutation({
    ...trpc.leads.setStatus.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const remove = useMutation({
    ...trpc.companies.remove.mutationOptions(),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries();
    },
  });

  if (!projectId) return <NoProject />;
  const rows = list.data?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.company.cnpj));

  const toggle = (cnpj: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(cnpj)) next.delete(cnpj);
      else next.add(cnpj);
      return next;
    });

  const exportUrl =
    `/api/export/${encodeURIComponent(projectId)}` +
    (filters.flag && filters.flag !== "any" && filters.flag !== "none"
      ? `?status=${filters.flag}`
      : "");

  return (
    <>
      <h1>Empresas</h1>
      <p className="lede">
        Tudo que se sabe sobre cada empresa do projeto. Marque as linhas e rode a rotina que
        quiser em cima delas.
      </p>

      <div className="panel">
        <div className="stats" style={{ marginBottom: 12 }}>
          <div>
            <b>
              <Num v={summary.data?.total ?? null} />
            </b>
            <span>no projeto</span>
          </div>
          <div>
            <b>
              <Num v={summary.data?.crawled ?? null} />
            </b>
            <span>com site lido</span>
          </div>
          <div>
            <b>
              <Num v={summary.data?.scored ?? null} />
            </b>
            <span>pontuadas</span>
          </div>
          <div>
            <b>
              <Num v={summary.data?.flagged ?? null} />
            </b>
            <span>marcadas</span>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? "Fechar busca" : "Adicionar empresas da base"}
          </button>
          <a className="btn" href={exportUrl} download>
            Baixar CSV<small>{rows.length} linhas</small>
          </a>
          <span className="spacer" />
          <label className="row" style={{ gap: 6 }}>
            profundidade
            <select
              className="sel"
              style={{ width: 150 }}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            >
              <option value={0}>só a home</option>
              <option value={2}>home + 2 páginas</option>
              <option value={4}>home + 4 páginas</option>
            </select>
          </label>
        </div>
      </div>

      {adding && <AddCompanies projectId={projectId} onAdded={() => qc.invalidateQueries()} />}

      <BatchBar
        projectId={projectId}
        selected={[...selected]}
        depth={depth}
        onDone={() => setSelected(new Set())}
      />

      <div className="panel">
        <div className="row">
          <input
            className="inp"
            style={{ maxWidth: 220 }}
            placeholder="nome ou CNPJ"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
          <input
            className="inp"
            style={{ maxWidth: 110 }}
            placeholder="CNAE"
            value={filters.cnae}
            onChange={(e) =>
              setFilters({ ...filters, cnae: e.target.value.replace(/\D/g, "") })
            }
          />
          <input
            className="inp"
            style={{ maxWidth: 80 }}
            placeholder="UF"
            maxLength={2}
            value={filters.uf}
            onChange={(e) => setFilters({ ...filters, uf: e.target.value })}
          />
          <select
            className="sel"
            style={{ maxWidth: 150 }}
            value={filters.flag}
            onChange={(e) => setFilters({ ...filters, flag: e.target.value })}
          >
            <option value="">marcação: todas</option>
            <option value="none">não marcadas</option>
            <option value="any">marcadas (qualquer)</option>
            {Object.entries(LEAD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            className="sel"
            style={{ maxWidth: 130 }}
            value={filters.crawled}
            onChange={(e) => setFilters({ ...filters, crawled: e.target.value })}
          >
            <option value="">site: todas</option>
            <option value="sim">site lido</option>
            <option value="nao">site não lido</option>
          </select>
          <select
            className="sel"
            style={{ maxWidth: 130 }}
            value={filters.scored}
            onChange={(e) => setFilters({ ...filters, scored: e.target.value })}
          >
            <option value="">nota: todas</option>
            <option value="sim">pontuadas</option>
            <option value="nao">sem nota</option>
          </select>
          <select
            className="sel"
            style={{ maxWidth: 150 }}
            value={filters.order}
            onChange={(e) => setFilters({ ...filters, order: e.target.value as "score" })}
          >
            <option value="score">maior nota</option>
            <option value="founded">mais novas</option>
            <option value="name">nome</option>
          </select>
          <span className="spacer" />
          <span className="muted">
            {rows.length} de <Num v={list.data?.total ?? null} />
          </span>
        </div>
        <ErrorBox error={remove.error ?? setLeadStatus.error} />
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? new Set(rows.map((r) => r.company.cnpj)) : new Set()
                    )
                  }
                />
              </th>
              <th>empresa</th>
              <th>site</th>
              <th>telefone</th>
              <th>nota</th>
              <th>gancho e conselho</th>
              <th>marcação</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ company, crawl, score, lead, contacts, guessedSite, places }) => {
              const s = crawl?.signals;
              const phone = contacts[0];
              return (
                <tr key={company.cnpj}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(company.cnpj)}
                      onChange={() => toggle(company.cnpj)}
                    />
                  </td>
                  <td className="wrap">
                    <div>
                      {company.nomeFantasia ?? company.razaoSocial ?? company.cnpj}
                      {company.mei && (
                        <span className="chip chip-plain" style={{ marginLeft: 6 }}>
                          MEI
                        </span>
                      )}
                    </div>
                    <div className="muted">
                      <code>{company.cnae}</code> · {company.municipio ?? "?"}/
                      {company.uf ?? "?"}
                      {company.dataInicioAtividade && ` · ${company.dataInicioAtividade}`}
                    </div>
                  </td>
                  <td className="wrap">
                    {crawl?.finalUrl ? (
                      <>
                        <a href={crawl.finalUrl} target="_blank" rel="noreferrer noopener">
                          {crawl.finalUrl.replace(/^https?:\/\//, "").slice(0, 30)}
                        </a>
                        <div>
                          {s?.isLinkHub && <span className="chip chip-warm">link na bio</span>}
                          {s?.isFreeBuilder && (
                            <span className="chip chip-warm">site grátis</span>
                          )}
                          {s?.hasViewport === false && (
                            <span className="chip chip-warm">não responsivo</span>
                          )}
                          {s?.platform && <span className="chip chip-plain">{s.platform}</span>}
                        </div>
                      </>
                    ) : crawl?.error ? (
                      <span className="chip chip-bad">{crawl.error}</span>
                    ) : places?.websiteUrl ? (
                      <span className="muted">
                        via Places: {places.websiteUrl.slice(0, 30)}
                      </span>
                    ) : guessedSite ? (
                      <span className="muted">
                        palpite: {guessedSite.replace(/^https?:\/\//, "")}
                      </span>
                    ) : (
                      <span className="muted">nenhum site conhecido</span>
                    )}
                  </td>
                  <td className="wrap">
                    {phone ? (
                      <>
                        <a href={phone.waMe ?? "#"} target="_blank" rel="noreferrer noopener">
                          {phone.phoneE164}
                        </a>
                        <span className="chip chip-plain" style={{ marginLeft: 4 }}>
                          {phone.isMobile ? "celular" : "fixo"}
                        </span>
                        {phone.source === "site" && (
                          <span className="chip chip-plain" style={{ marginLeft: 4 }}>
                            do site
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <Tier tier={score?.tier ?? null} />{" "}
                    {score?.bestFit ?? <span className="muted">—</span>}
                    {score?.wrongType && (
                      <div>
                        <span className="chip chip-bad">ramo errado</span>
                      </div>
                    )}
                    {score?.error && (
                      <div>
                        <span className="chip chip-bad">falhou</span>
                      </div>
                    )}
                  </td>
                  <td className="wrap">
                    {score?.hook && <div>{score.hook}</div>}
                    {score?.advice && <div className="muted">{score.advice}</div>}
                    {!score?.hook && !score?.advice && <span className="muted">—</span>}
                  </td>
                  <td>
                    {lead ? (
                      <select
                        className="sel"
                        style={{ width: 118 }}
                        value={lead.status}
                        onChange={(e) =>
                          setLeadStatus.mutate({
                            projectId,
                            cnpj: company.cnpj,
                            status: e.target.value as "flagged",
                          })
                        }
                      >
                        {Object.entries(LEAD_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {lead && (
                      <div>
                        <span className={`chip ${LEAD_CHIP[lead.status]}`}>
                          {LEAD_LABEL[lead.status]}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {summary.data?.total
                    ? "nenhuma empresa com esses filtros"
                    : "nenhuma empresa no projeto — use “Adicionar empresas da base”"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="muted">carregando…</p>}>
      <CompaniesTab />
    </Suspense>
  );
}
