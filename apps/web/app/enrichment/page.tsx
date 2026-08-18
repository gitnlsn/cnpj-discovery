"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox, NoProject, Num } from "@/components/bits";

/**
 * Nothing on this tab runs implicitly.
 *
 * Every action is a button on one company, and every button says what it costs.
 * That is the whole difference from a pipeline that quietly spends a paid quota
 * because a page was loaded.
 */
function EnrichmentTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [depth, setDepth] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useQuery({
    ...trpc.enrichment.list.queryOptions({ projectId: projectId ?? "", limit: 200 }),
    enabled: Boolean(projectId),
  });
  const pending = useQuery({
    ...trpc.enrichment.pending.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });
  const usage = useQuery(trpc.enrichment.usage.queryOptions());

  const refresh = () => {
    void qc.invalidateQueries({
      queryKey: trpc.enrichment.list.queryKey({ projectId: projectId ?? "", limit: 200 }),
    });
    void qc.invalidateQueries({
      queryKey: trpc.enrichment.pending.queryKey({ projectId: projectId ?? "" }),
    });
  };

  const reveal = useMutation({
    ...trpc.enrichment.revealPhone.mutationOptions(),
    onSettled: () => { setBusy(null); refresh(); },
  });
  const crawl = useMutation({
    ...trpc.enrichment.crawl.mutationOptions(),
    onSettled: () => { setBusy(null); refresh(); },
  });

  if (!projectId) return <NoProject />;
  const rows = list.data ?? [];

  return (
    <>
      <h1>Enriquecimento</h1>
      <p className="lede">
        A Receita não tem campo de site — é a única coisa que falta e a que mais
        importa. O telefone, esse já veio no download: o botão só normaliza,
        classifica a linha e guarda para <i>esta</i> empresa.
      </p>

      <div className="panel">
        <div className="stats">
          <div><b><Num v={rows.length} /></b><span>no projeto</span></div>
          <div><b><Num v={pending.data?.notCrawled ?? null} /></b><span>sem crawl</span></div>
          <div><b><Num v={pending.data?.withGuessableSite ?? null} /></b><span>com site adivinhável</span></div>
          <div><b><Num v={usage.data?.placesLookups ?? null} /></b><span>buscas no places</span></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="row" style={{ gap: 6 }}>
            profundidade do crawl
            <select
              className="sel" style={{ width: 200 }} value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            >
              <option value={0}>só a home</option>
              <option value={2}>home + 2 páginas</option>
              <option value={4}>home + 4 páginas</option>
            </select>
          </label>
          <span className="muted">
            respeita robots.txt e espera 1s entre requisições ao mesmo host
          </span>
        </div>
      </div>

      <ErrorBox error={crawl.error ?? reveal.error} />

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>empresa</th><th>site</th><th>sinais</th>
              <th>telefone</th><th>ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ company, crawl: c, contacts, guessedSite }) => {
              const signals = (c?.signals ?? null) as Record<string, unknown> | null;
              const isBusy = busy === company.cnpj;
              return (
                <tr key={company.cnpj}>
                  <td className="wrap">
                    <div>{company.nomeFantasia ?? company.razaoSocial ?? "(sem nome)"}</div>
                    <div className="muted">
                      <code>{company.cnae}</code> · {company.municipio ?? "?"}/{company.uf ?? "?"}
                    </div>
                  </td>
                  <td className="wrap">
                    {c?.finalUrl ? (
                      <a href={c.finalUrl} target="_blank" rel="noreferrer noopener">{c.finalUrl}</a>
                    ) : guessedSite ? (
                      <span className="muted">palpite: {guessedSite}</span>
                    ) : (
                      <span className="muted">nenhum site conhecido</span>
                    )}
                    {c?.urlSource && (
                      <span className="chip chip-plain" style={{ marginLeft: 6 }}>{c.urlSource}</span>
                    )}
                  </td>
                  <td>
                    {!c ? (
                      <span className="muted">não verificado</span>
                    ) : c.error ? (
                      <span className="chip chip-bad">{c.error}</span>
                    ) : (
                      <>
                        {signals?.isLinkHub === true && <span className="chip chip-warm">link na bio</span>}
                        {signals?.isDead === true && <span className="chip chip-bad">fora do ar</span>}
                        {signals?.isFreeBuilder === true && <span className="chip chip-warm">site grátis</span>}
                        {signals?.hasViewport === false && <span className="chip chip-warm">não responsivo</span>}
                        {signals?.hasWaLink === true && <span className="chip chip-plain">whatsapp</span>}
                        {typeof signals?.platform === "string" && (
                          <span className="chip chip-plain">{signals.platform}</span>
                        )}
                        <span className="muted" style={{ marginLeft: 6 }}>
                          {c.pagesFetched} pág.
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {contacts.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      contacts.map((ct) => (
                        <div key={ct.phoneE164}>
                          <a href={ct.waMe ?? "#"} target="_blank" rel="noreferrer noopener">
                            {ct.phoneE164}
                          </a>
                          <span className="chip chip-plain" style={{ marginLeft: 6 }}>
                            {ct.isMobile ? "celular" : "fixo"}
                          </span>
                          <span className="chip chip-plain" style={{ marginLeft: 4 }}>{ct.source}</span>
                        </div>
                      ))
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        className="btn" disabled={isBusy}
                        onClick={() => { setBusy(company.cnpj); reveal.mutate({ cnpj: company.cnpj }); }}
                      >
                        Telefone<small>grátis</small>
                      </button>
                      <button
                        className="btn" disabled={isBusy || (!guessedSite && !c?.websiteUrl)}
                        title={!guessedSite && !c?.websiteUrl ? "nenhum site conhecido para visitar" : ""}
                        onClick={() => {
                          setBusy(company.cnpj);
                          crawl.mutate({ projectId, cnpj: company.cnpj, depth });
                        }}
                      >
                        {isBusy && crawl.isPending ? "Lendo…" : "Crawl"}<small>grátis</small>
                      </button>
                      <button className="btn" disabled title="ver aviso abaixo">
                        Places<small>cota paga</small>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  nenhuma empresa neste projeto — adicione algumas na aba Descoberta
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <b>Sobre o botão do Google Places.</b>{" "}
        <span className="muted">
          Ele está desligado. É a única etapa que gasta dinheiro de verdade, e os
          termos do Google só permitem guardar o <code>place_id</code> — nunca nome,
          telefone ou avaliação. Por isso ele grava numa tabela separada
          (<code>places_lookups</code>), e por isso não liga sozinho.
          {usage.data?.placesConfigured === false && " GOOGLE_MAPS_API_KEY não está configurada."}
        </span>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="muted">carregando…</p>}>
      <EnrichmentTab />
    </Suspense>
  );
}
