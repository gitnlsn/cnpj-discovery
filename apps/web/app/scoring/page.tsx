"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox, NoProject, Num, Tier } from "@/components/bits";

type View = "ranked" | "discarded" | "failed";

/**
 * The ranked list, plus two piles that are usually hidden and should not be.
 *
 * `discarded` holds companies the model judged to be in the wrong line of
 * business — a fact, not a low score, and shown with its reason. `failed` holds
 * calls that broke: those rows have no score at all rather than a made-up one,
 * and a filter you cannot inspect is indistinguishable from a hole in the data.
 */
function ScoringTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [view, setView] = useState<View>("ranked");
  const [limit, setLimit] = useState(50);

  const stats = useQuery({
    ...trpc.project.stats.queryOptions({ id: projectId ?? "" }),
    enabled: Boolean(projectId),
  });
  const results = useQuery({
    ...trpc.scoring.results.queryOptions({ projectId: projectId ?? "", include: view, limit: 200 }),
    enabled: Boolean(projectId),
  });

  // Scoring runs as a job, so this polls while one is in flight and stops the
  // moment it is not. A fixed interval would keep waking an idle page forever.
  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.current ? 1500 : false),
  });
  const running = jobs.data?.current ?? null;
  const progress = (running?.progress ?? null) as { done: number; total: number } | null;

  const run = useMutation({
    ...trpc.scoring.run.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
  });
  const cancel = useMutation({
    ...trpc.jobs.cancel.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
  });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const flagged = useQuery({
    ...trpc.leads.list.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });
  const alreadyFlagged = new Set((flagged.data ?? []).map((l) => l.lead.cnpj));

  const flag = useMutation({
    ...trpc.leads.flag.mutationOptions(),
    onSuccess: () => {
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: trpc.leads.list.queryKey() });
      void qc.invalidateQueries({ queryKey: trpc.leads.counts.queryKey() });
    },
  });

  // When the job disappears, the tables underneath it are stale.
  const [lastJob, setLastJob] = useState<number | null>(null);
  if (running && running.id !== lastJob) setLastJob(running.id);
  if (!running && lastJob !== null) {
    setLastJob(null);
    void qc.invalidateQueries({ queryKey: trpc.scoring.results.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.project.stats.queryKey({ id: projectId ?? "" }) });
  }

  if (!projectId) return <NoProject />;
  const rows = results.data ?? [];

  return (
    <>
      <h1>Pontuação e conselho</h1>
      <p className="lede">
        Cada empresa é avaliada contra a rubrica do projeto. Quando a chamada
        falha, a nota fica <b>vazia</b> e o erro é gravado — nunca um 5 inventado,
        que ficaria para sempre acima dos 4 verdadeiros sem nada indicar que foi
        chute.
      </p>

      <div className="panel">
        <div className="stats" style={{ marginBottom: 12 }}>
          <div><b><Num v={stats.data?.companies ?? null} /></b><span>empresas</span></div>
          <div><b><Num v={stats.data?.scored ?? null} /></b><span>pontuadas</span></div>
          <div><b><Num v={stats.data?.hot ?? null} /></b><span>hot</span></div>
          <div><b><Num v={stats.data?.warm ?? null} /></b><span>warm</span></div>
          <div><b><Num v={stats.data?.cold ?? null} /></b><span>cold</span></div>
          <div><b><Num v={stats.data?.wrongType ?? null} /></b><span>descartadas</span></div>
          <div><b><Num v={stats.data?.failed ?? null} /></b><span>falharam</span></div>
        </div>
        <div className="row">
          <button
            className="btn btn-primary" disabled={run.isPending || Boolean(running)}
            onClick={() => run.mutate({ projectId, limit, batchSize: 10 })}
          >
            {running ? "Pontuando…" : `Pontuar ${limit}`}
            <small>gasta LLM · ~{Math.ceil(limit / 10)} requisições</small>
          </button>
          {running && (
            <>
              <span className="muted">
                {progress ? `${progress.done}/${progress.total}` : "iniciando…"}
              </span>
              <button className="btn" onClick={() => cancel.mutate({ id: running.id })}>
                Cancelar
              </button>
            </>
          )}
          <select
            className="sel" style={{ width: 110 }} value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="spacer" />
          <div className="row" style={{ gap: 4 }}>
            {(["ranked", "discarded", "failed"] as View[]).map((v) => (
              <button
                key={v} className="btn"
                style={view === v ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                onClick={() => setView(v)}
              >
                {v === "ranked" ? "Ranqueadas" : v === "discarded" ? "Descartadas" : "Falharam"}
              </button>
            ))}
          </div>
        </div>
        <ErrorBox error={run.error ?? flag.error} />
      </div>

      {view === "ranked" && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button
            className="btn btn-primary"
            disabled={picked.size === 0 || flag.isPending}
            onClick={() => flag.mutate({ projectId, cnpjs: [...picked] })}
          >
            Marcar {picked.size} como lead
          </button>
          <span className="muted">vão para a aba Leads, onde dá para baixar o CSV</span>
        </div>
      )}

      {view === "discarded" && (
        <p className="muted" style={{ marginTop: -4 }}>
          O modelo julgou que estas empresas são de <b>outro ramo</b> — não que são
          um encaixe fraco. O CNAE é um filtro grosso: “cursos preparatórios”
          contém, de verdade, uma empresa de balonismo e uma clínica de oncologia.
        </p>
      )}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {view === "ranked" && <th></th>}
              <th>empresa</th>
              {view === "ranked" && <><th>tier</th><th className="num">nota</th><th>confiança</th></>}
              <th>{view === "failed" ? "erro" : view === "discarded" ? "motivo" : "gancho"}</th>
              {view === "ranked" && <th>conselho</th>}
              <th>modelo</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit * 4).map(({ score, company, finalUrl }) => {
              const evidence = score.evidence as { justification?: string } | null;
              return (
                <tr key={score.cnpj}>
                  {view === "ranked" && (
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(score.cnpj) || alreadyFlagged.has(score.cnpj)}
                        disabled={alreadyFlagged.has(score.cnpj)}
                        title={alreadyFlagged.has(score.cnpj) ? "já está nos leads" : ""}
                        onChange={() =>
                          setPicked((s) => {
                            const next = new Set(s);
                            if (next.has(score.cnpj)) next.delete(score.cnpj);
                            else next.add(score.cnpj);
                            return next;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="wrap">
                    <div>{company?.nomeFantasia ?? company?.razaoSocial ?? score.cnpj}</div>
                    <div className="muted">
                      <code>{company?.cnae}</code> · {company?.municipio ?? "?"}/{company?.uf ?? "?"}
                      {finalUrl && (
                        <> · <a href={finalUrl} target="_blank" rel="noreferrer noopener">site</a></>
                      )}
                    </div>
                  </td>
                  {view === "ranked" && (
                    <>
                      <td><Tier tier={score.tier} /></td>
                      <td className="num">
                        {score.bestFit ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className={`chip ${score.confidence === "high" ? "chip-plain" : "chip-warm"}`}>
                          {score.confidence ?? "—"}
                        </span>
                      </td>
                    </>
                  )}
                  <td className="wrap">
                    {view === "failed"
                      ? <span className="chip chip-bad">{score.error}</span>
                      : view === "discarded"
                        ? <span className="muted">{evidence?.justification ?? "—"}</span>
                        : (score.hook ?? <span className="muted">sem gancho honesto a dar</span>)}
                  </td>
                  {view === "ranked" && (
                    <td className="wrap muted">{score.advice ?? "—"}</td>
                  )}
                  <td className="muted">{score.model ?? "—"}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {view === "ranked"
                    ? "nada pontuado ainda"
                    : view === "discarded"
                      ? "nenhuma empresa descartada por ramo"
                      : "nenhuma falha — todas as chamadas voltaram"}
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
      <ScoringTab />
    </Suspense>
  );
}
