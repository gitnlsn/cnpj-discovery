"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox, NoProject, Num } from "@/components/bits";

/**
 * The three outcomes of checking a CNAE the model proposed, kept separate.
 *
 * "unknown" means the code does not exist — the model invented it. Folding that
 * into "empty" would hide the hallucination behind a plausible zero, which is
 * precisely how a made-up segment survives review.
 */
const STATUS_LABEL: Record<string, { chip: string; text: string }> = {
  ok: { chip: "chip-plain", text: "existe" },
  empty: { chip: "chip-warm", text: "sem empresas" },
  unknown: { chip: "chip-bad", text: "código inventado" },
};

type Order = "founded-desc" | "founded-asc" | "name" | "capital-desc";

function DiscoveryTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [order, setOrder] = useState<Order>("founded-desc");
  const [uf, setUf] = useState("");
  const [hasPhone, setHasPhone] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const picks = useQuery({
    ...trpc.discovery.picks.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const invalidatePicks = () =>
    qc.invalidateQueries({
      queryKey: trpc.discovery.picks.queryKey({ projectId: projectId ?? "" }),
    });

  const suggest = useMutation({
    ...trpc.discovery.suggest.mutationOptions(),
    onSuccess: () => void invalidatePicks(),
  });
  const setChosen = useMutation({
    ...trpc.discovery.setChosen.mutationOptions(),
    onSuccess: () => void invalidatePicks(),
  });
  const addCompanies = useMutation({
    ...trpc.discovery.addCompanies.mutationOptions(),
    onSuccess: () => setSelected(new Set()),
  });

  const chosen = (picks.data ?? [])
    .filter((p) => p.chosen && p.status === "ok")
    .map((p) => p.cnae);

  const filters = {
    cnae: chosen.length ? chosen : undefined,
    uf: uf.length === 2 ? [uf.toUpperCase()] : undefined,
    hasPhone: hasPhone || undefined,
  };

  const companies = useQuery({
    ...trpc.discovery.companies.queryOptions({ filters, order, limit: 100, offset: 0 }),
    enabled: chosen.length > 0,
  });
  const reach = useQuery({
    ...trpc.discovery.reach.queryOptions({ filters }),
    enabled: chosen.length > 0,
  });

  if (!projectId) return <NoProject />;

  const toggle = (cnpj: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(cnpj)) next.delete(cnpj);
      else next.add(cnpj);
      return next;
    });

  return (
    <>
      <h1>Descoberta de CNPJ</h1>
      <p className="lede">
        O modelo sugere CNAEs para o seu perfil. Cada sugestão é conferida contra a
        tabela oficial e contra a contagem real <b>antes</b> de aparecer aqui — o
        modelo inventa códigos, e um código inventado fica marcado, não sumido.
      </p>

      <div className="panel">
        <div className="row">
          <button
            className="btn btn-primary"
            disabled={suggest.isPending}
            onClick={() => suggest.mutate({ projectId })}
          >
            {suggest.isPending ? "Perguntando…" : "Sugerir CNAEs"}
            <small>gasta LLM · 1 chamada</small>
          </button>
          <span className="muted">as contagens são grátis: vêm do Parquet local</span>
        </div>
        <ErrorBox error={suggest.error} />
      </div>

      {(picks.data ?? []).length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th></th><th>cnae</th><th>situação</th><th>descrição oficial</th>
                <th className="num">empresas</th><th className="num">com telefone</th>
                <th className="num">abertas 24m</th><th>por quê</th>
              </tr>
            </thead>
            <tbody>
              {(picks.data ?? []).map((p) => {
                const s = STATUS_LABEL[p.status] ?? STATUS_LABEL.unknown!;
                return (
                  <tr key={p.cnae}>
                    <td>
                      <input
                        type="checkbox"
                        checked={p.chosen}
                        disabled={p.status !== "ok"}
                        onChange={(e) =>
                          setChosen.mutate({ projectId, cnae: p.cnae, chosen: e.target.checked })
                        }
                      />
                    </td>
                    <td><code>{p.cnae}</code></td>
                    <td><span className={`chip ${s.chip}`}>{s.text}</span></td>
                    <td className="wrap">
                      {p.descricao ?? (
                        <span className="muted">não existe na tabela oficial de CNAEs</span>
                      )}
                    </td>
                    <td className="num"><Num v={p.reachTotal} /></td>
                    <td className="num"><Num v={p.reachWithPhone} /></td>
                    <td className="num"><Num v={p.reachRecent} /></td>
                    <td className="wrap muted">{p.rationale}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {chosen.length > 0 && (
        <>
          <h2>Empresas</h2>
          <div className="panel">
            <div className="row">
              <select
                className="sel" style={{ maxWidth: 220 }} value={order}
                onChange={(e) => setOrder(e.target.value as Order)}
              >
                <option value="founded-desc">mais novas primeiro</option>
                <option value="founded-asc">mais antigas primeiro</option>
                <option value="name">nome</option>
                <option value="capital-desc">maior capital</option>
              </select>
              <input
                className="inp" style={{ maxWidth: 90 }} placeholder="UF" maxLength={2}
                value={uf} onChange={(e) => setUf(e.target.value)}
              />
              <label className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox" checked={hasPhone}
                  onChange={(e) => setHasPhone(e.target.checked)}
                />
                só com telefone
              </label>
              <span className="spacer" />
              {reach.data && (
                <span className="muted">
                  <b><Num v={reach.data.total} /></b> empresas ·{" "}
                  <Num v={reach.data.withPhone} /> com telefone ·{" "}
                  <Num v={reach.data.recent} /> abertas nos últimos 24 meses
                </span>
              )}
            </div>
          </div>

          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="btn btn-primary"
              disabled={selected.size === 0 || addCompanies.isPending}
              onClick={() =>
                addCompanies.mutate({ projectId, cnpjs: [...selected], sourcePeriod: "2026-08" })
              }
            >
              Adicionar {selected.size} ao projeto
            </button>
            <span className="muted">
              é o único momento em que algo da base da Receita é gravado
            </span>
          </div>
          <ErrorBox error={addCompanies.error} />

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th></th><th>nome</th><th>cnae</th><th>local</th>
                  <th>aberta em</th><th>telefone</th><th>e-mail</th><th>porte</th>
                </tr>
              </thead>
              <tbody>
                {(companies.data ?? []).map((c) => (
                  <tr key={c.cnpj}>
                    <td>
                      <input
                        type="checkbox" checked={selected.has(c.cnpj)}
                        onChange={() => toggle(c.cnpj)}
                      />
                    </td>
                    <td className="wrap">
                      {c.nomeFantasia ?? c.razaoSocial ?? <span className="muted">(sem nome)</span>}
                      {c.mei && <span className="chip chip-plain" style={{ marginLeft: 6 }}>MEI</span>}
                    </td>
                    <td><code>{c.cnae}</code></td>
                    <td>{c.municipio ?? "?"}/{c.uf}</td>
                    <td>{c.dataInicioAtividade ?? <span className="muted">—</span>}</td>
                    <td>
                      {c.phone ? (
                        <>
                          {c.phone.e164}
                          <span className="chip chip-plain" style={{ marginLeft: 6 }}>
                            {c.phone.isMobile ? "celular" : "fixo"}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="wrap muted">{c.email ?? "—"}</td>
                    <td>{c.porte ?? "—"}</td>
                  </tr>
                ))}
                {companies.isLoading && (
                  <tr><td colSpan={8} className="muted">consultando…</td></tr>
                )}
                {companies.data?.length === 0 && (
                  <tr><td colSpan={8} className="muted">nenhuma empresa com esses filtros</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="muted">carregando…</p>}>
      <DiscoveryTab />
    </Suspense>
  );
}
