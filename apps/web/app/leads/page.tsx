"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox, NoProject, Num, Tier } from "@/components/bits";

const STATUSES = ["flagged", "contacted", "replied", "won", "lost"] as const;
type Status = (typeof STATUSES)[number];

const LABEL: Record<Status, string> = {
  flagged: "marcado",
  contacted: "contatado",
  replied: "respondeu",
  won: "fechou",
  lost: "não deu",
};

const CHIP: Record<Status, string> = {
  flagged: "chip-plain",
  contacted: "chip-warm",
  replied: "chip-hot",
  won: "chip-hot",
  lost: "chip-bad",
};

/**
 * The last step: the companies you decided to pursue.
 *
 * Everything here is a record of a decision a person made. The status moves
 * because you moved it — nothing in this app contacts anyone, and the wa.me
 * link opens WhatsApp rather than sending through it.
 */
function LeadsTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [filter, setFilter] = useState<Status | "">("");

  const list = useQuery({
    ...trpc.leads.list.queryOptions({
      projectId: projectId ?? "",
      ...(filter ? { status: filter } : {}),
    }),
    enabled: Boolean(projectId),
  });
  const counts = useQuery({
    ...trpc.leads.counts.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.leads.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.leads.counts.queryKey() });
  };

  const setStatus = useMutation({ ...trpc.leads.setStatus.mutationOptions(), onSuccess: refresh });
  const setNotes = useMutation({ ...trpc.leads.setNotes.mutationOptions(), onSuccess: refresh });
  const unflag = useMutation({ ...trpc.leads.unflag.mutationOptions(), onSuccess: refresh });

  if (!projectId) return <NoProject />;
  const rows = list.data ?? [];
  const exportUrl = `/api/export/${encodeURIComponent(projectId)}${filter ? `?status=${filter}` : ""}`;

  return (
    <>
      <h1>Leads</h1>
      <p className="lede">
        As empresas que você marcou como vale a pena. O estado muda porque{" "}
        <b>você</b> muda — o app registra o que você fez, nunca manda mensagem.
      </p>

      <div className="panel">
        <div className="stats" style={{ marginBottom: 12 }}>
          <div><b><Num v={counts.data?.total ?? null} /></b><span>marcados</span></div>
          {STATUSES.map((s) => (
            <div key={s}>
              <b><Num v={counts.data?.[s] ?? null} /></b>
              <span>{LABEL[s]}</span>
            </div>
          ))}
        </div>
        <div className="row">
          <select
            className="sel" style={{ maxWidth: 190 }} value={filter}
            onChange={(e) => setFilter(e.target.value as Status | "")}
          >
            <option value="">todos os estados</option>
            {STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>
          <span className="spacer" />
          <a className="btn" href={exportUrl} download>
            Baixar CSV
            <small>{filter ? LABEL[filter] : "tudo"} · {rows.length} linhas</small>
          </a>
        </div>
        <ErrorBox error={setStatus.error ?? setNotes.error ?? unflag.error} />
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>empresa</th><th>nota</th><th>contato</th>
              <th>gancho</th><th>estado</th><th>anotações</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ lead, company, score, finalUrl, contacts }) => {
              const phone = contacts[0];
              return (
                <tr key={lead.cnpj}>
                  <td className="wrap">
                    <div>{company?.nomeFantasia ?? company?.razaoSocial ?? lead.cnpj}</div>
                    <div className="muted">
                      <code>{company?.cnae}</code> · {company?.municipio ?? "?"}/{company?.uf ?? "?"}
                      {finalUrl && (
                        <> · <a href={finalUrl} target="_blank" rel="noreferrer noopener">site</a></>
                      )}
                    </div>
                  </td>
                  <td>
                    <Tier tier={score?.tier ?? null} />{" "}
                    {score?.bestFit ?? <span className="muted">—</span>}
                  </td>
                  <td className="wrap">
                    {phone ? (
                      <>
                        <a href={phone.waMe ?? "#"} target="_blank" rel="noreferrer noopener">
                          {phone.phoneE164}
                        </a>
                        <span className="chip chip-plain" style={{ marginLeft: 6 }}>
                          {phone.isMobile ? "celular" : "fixo"}
                        </span>
                        {phone.source === "site" && (
                          <span className="chip chip-plain" style={{ marginLeft: 4 }}>do site</span>
                        )}
                      </>
                    ) : (
                      <span className="muted">revele na aba Enriquecimento</span>
                    )}
                  </td>
                  <td className="wrap">
                    {score?.hook ?? <span className="muted">—</span>}
                  </td>
                  <td>
                    <select
                      className="sel" style={{ width: 120 }} value={lead.status}
                      onChange={(e) =>
                        setStatus.mutate({
                          projectId, cnpj: lead.cnpj, status: e.target.value as Status,
                        })
                      }
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
                    </select>
                    <div>
                      <span className={`chip ${CHIP[lead.status]}`}>{LABEL[lead.status]}</span>
                    </div>
                    {lead.contactedAt && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {new Date(lead.contactedAt).toLocaleDateString("pt-BR")}
                      </div>
                    )}
                  </td>
                  <td className="wrap">
                    <textarea
                      className="inp" style={{ minHeight: 44, width: 220 }}
                      defaultValue={lead.notes ?? ""}
                      placeholder="o que aconteceu…"
                      onBlur={(e) =>
                        e.target.value !== (lead.notes ?? "") &&
                        setNotes.mutate({ projectId, cnpj: lead.cnpj, notes: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="btn"
                      onClick={() => unflag.mutate({ projectId, cnpj: lead.cnpj })}
                    >
                      Desmarcar
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  nada marcado ainda — marque empresas na aba Pontuação
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
      <LeadsTab />
    </Suspense>
  );
}
