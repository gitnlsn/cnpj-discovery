"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { ErrorBox, Num } from "@/components/bits";

type Order = "founded-desc" | "founded-asc" | "name" | "capital-desc";

/**
 * Search the Receita base and pull companies into the project.
 *
 * This is the only place anything from the 12M-row Parquet base is written to
 * the app's own database. Everything else reads it in place.
 *
 * The CNAEs offered here are the project's chosen ones, so a code the model
 * invented cannot get this far — it was already refused on the project tab.
 */
export function AddCompanies({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: () => void;
}) {
  const trpc = useTRPC();
  const [order, setOrder] = useState<Order>("founded-desc");
  const [uf, setUf] = useState("");
  const [hasPhone, setHasPhone] = useState(true);
  const [foundedFrom, setFoundedFrom] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const picks = useQuery(trpc.discovery.picks.queryOptions({ projectId }));
  const chosen = (picks.data ?? [])
    .filter((p) => p.chosen && p.status === "ok")
    .map((p) => p.cnae);

  const filters = {
    cnae: chosen.length ? chosen : undefined,
    uf: uf.length === 2 ? [uf.toUpperCase()] : undefined,
    hasPhone: hasPhone || undefined,
    foundedFrom: /^\d{4}-\d{2}-\d{2}$/.test(foundedFrom) ? foundedFrom : undefined,
  };

  const results = useQuery({
    ...trpc.discovery.companies.queryOptions({ filters, order, limit: 100, offset: 0 }),
    enabled: chosen.length > 0,
  });
  const reach = useQuery({
    ...trpc.discovery.reach.queryOptions({ filters }),
    enabled: chosen.length > 0,
  });
  const add = useMutation({
    ...trpc.discovery.addCompanies.mutationOptions(),
    onSuccess: () => {
      setPicked(new Set());
      onAdded();
    },
  });

  if (chosen.length === 0) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          Nenhum CNAE escolhido. Vá na aba <b>Projetos</b>, sugira ou adicione CNAEs e marque os
          que quer usar.
        </p>
      </div>
    );
  }

  const toggle = (cnpj: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(cnpj)) next.delete(cnpj);
      else next.add(cnpj);
      return next;
    });

  const rows = results.data ?? [];

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <b>Buscar na base</b>
        <select
          className="sel"
          style={{ maxWidth: 190 }}
          value={order}
          onChange={(e) => setOrder(e.target.value as Order)}
        >
          <option value="founded-desc">mais novas primeiro</option>
          <option value="founded-asc">mais antigas primeiro</option>
          <option value="name">nome</option>
          <option value="capital-desc">maior capital</option>
        </select>
        <input
          className="inp"
          style={{ maxWidth: 80 }}
          placeholder="UF"
          maxLength={2}
          value={uf}
          onChange={(e) => setUf(e.target.value)}
        />
        <input
          className="inp"
          style={{ maxWidth: 150 }}
          placeholder="abertas a partir de"
          value={foundedFrom}
          onChange={(e) => setFoundedFrom(e.target.value)}
          title="AAAA-MM-DD"
        />
        <label className="row" style={{ gap: 4 }}>
          <input
            type="checkbox"
            checked={hasPhone}
            onChange={(e) => setHasPhone(e.target.checked)}
          />
          só com telefone
        </label>
        <span className="spacer" />
        {reach.data && (
          <span className="muted">
            <b>
              <Num v={reach.data.total} />
            </b>{" "}
            na base · <Num v={reach.data.recent} /> abertas nos últimos 24 meses
          </span>
        )}
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="btn btn-primary"
          disabled={picked.size === 0 || add.isPending}
          onClick={() => add.mutate({ projectId, cnpjs: [...picked], sourcePeriod: "2026-08" })}
        >
          Adicionar {picked.size} ao projeto
        </button>
        <button
          className="btn"
          disabled={rows.length === 0}
          onClick={() => setPicked(new Set(rows.map((r) => r.cnpj)))}
        >
          Selecionar os {rows.length} da página
        </button>
      </div>
      <ErrorBox error={add.error} />

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th></th>
              <th>nome</th>
              <th>cnae</th>
              <th>local</th>
              <th>aberta em</th>
              <th>telefone</th>
              <th>e-mail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.cnpj}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.has(c.cnpj)}
                    onChange={() => toggle(c.cnpj)}
                  />
                </td>
                <td className="wrap">
                  {c.nomeFantasia ?? c.razaoSocial ?? <span className="muted">(sem nome)</span>}
                  {c.mei && (
                    <span className="chip chip-plain" style={{ marginLeft: 6 }}>
                      MEI
                    </span>
                  )}
                </td>
                <td>
                  <code>{c.cnae}</code>
                </td>
                <td>
                  {c.municipio ?? "?"}/{c.uf}
                </td>
                <td>{c.dataInicioAtividade ?? <span className="muted">—</span>}</td>
                <td>
                  {c.phone ? (
                    <>
                      {c.phone.e164}
                      <span className="chip chip-plain" style={{ marginLeft: 4 }}>
                        {c.phone.isMobile ? "celular" : "fixo"}
                      </span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="wrap muted">{c.email ?? "—"}</td>
              </tr>
            ))}
            {results.isLoading && (
              <tr>
                <td colSpan={7} className="muted">
                  consultando…
                </td>
              </tr>
            )}
            {rows.length === 0 && !results.isLoading && (
              <tr>
                <td colSpan={7} className="muted">
                  nenhuma empresa com esses filtros
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
