"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { ErrorBox } from "@/components/bits";

/**
 * What you can run over the selected rows.
 *
 * Every button says what it costs, because the difference between free and
 * paid is the one thing you cannot undo. `grátis` means local work or our own
 * HTTP; `gasta LLM` means the free-model daily cap; `cota paga` means Google.
 */
export function BatchBar({
  projectId,
  selected,
  depth,
  onDone,
}: {
  projectId: string;
  selected: string[];
  depth: number;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const n = selected.length;

  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.current ? 1500 : false),
  });
  const running = jobs.data?.current ?? null;
  const progress = (running?.progress ?? null) as { done: number; total: number } | null;
  const usage = useQuery(trpc.enrichment.usage.queryOptions());

  const after = () => {
    onDone();
    qc.invalidateQueries();
  };
  const reveal = useMutation({
    ...trpc.enrichment.revealPhoneBatch.mutationOptions(),
    onSuccess: after,
  });
  const crawl = useMutation({
    ...trpc.enrichment.crawlBatch.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
  });
  const score = useMutation({
    ...trpc.scoring.run.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
  });
  const flag = useMutation({ ...trpc.leads.flag.mutationOptions(), onSuccess: after });
  const places = useMutation({
    ...trpc.enrichment.placesBatch.mutationOptions(),
    onSuccess: after,
  });
  const cancel = useMutation({
    ...trpc.jobs.cancel.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
  });

  const busy = Boolean(running);
  const none = n === 0;
  const quotaLeft = usage.data?.placesRemaining ?? 0;

  return (
    <div className="panel">
      <div className="row">
        <b style={{ minWidth: 96 }}>
          {none ? "nada marcado" : `${n} selecionada${n > 1 ? "s" : ""}`}
        </b>

        <button
          className="btn"
          disabled={none || reveal.isPending}
          onClick={() => reveal.mutate({ cnpjs: selected })}
        >
          Revelar telefone<small>grátis</small>
        </button>

        <button
          className="btn"
          disabled={none || busy}
          onClick={() => crawl.mutate({ projectId, cnpjs: selected, depth, concurrency: 6 })}
        >
          Visitar site<small>grátis</small>
        </button>

        <button
          className="btn"
          disabled={none || busy}
          onClick={() => score.mutate({ projectId, cnpjs: selected, batchSize: 10 })}
        >
          Pontuar<small>gasta LLM · ~{Math.ceil(n / 10)} req</small>
        </button>

        <button
          className="btn btn-primary"
          disabled={none || flag.isPending}
          onClick={() => flag.mutate({ projectId, cnpjs: selected })}
        >
          Marcar como lead<small>grátis</small>
        </button>

        <button
          className="btn"
          disabled={
            none || !usage.data?.placesConfigured || quotaLeft === 0 || places.isPending
          }
          title={
            !usage.data?.placesConfigured
              ? "GOOGLE_MAPS_API_KEY não configurada"
              : quotaLeft === 0
                ? "cota gratuita do mês esgotada"
                : "procura o site no Google Maps"
          }
          onClick={() => places.mutate({ projectId, cnpjs: selected, allowPaid: true })}
        >
          Buscar site no Places
          <small>
            cota paga · {quotaLeft} de {usage.data?.placesMonthly ?? 0}
          </small>
        </button>

        {running && (
          <>
            <span className="muted">
              {running.kind === "crawl" ? "visitando" : "pontuando"}{" "}
              {progress ? `${progress.done}/${progress.total}` : "…"}
            </span>
            <button className="btn" onClick={() => cancel.mutate({ id: running.id })}>
              Cancelar
            </button>
          </>
        )}
      </div>

      {crawl.data?.skipped ? (
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {crawl.data.skipped} sem site conhecido — o e-mail é gmail, ou é do contador. Tente o
          Places nessas.
        </p>
      ) : null}
      {places.data ? (
        <p className="muted" style={{ margin: "8px 0 0" }}>
          Places: {places.data.looked} consultadas, {places.data.withSite} com site.
          {places.data.stoppedOnQuota &&
            " Parei na cota gratuita — o que já foi feito está salvo."}
        </p>
      ) : null}
      {reveal.data ? (
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {reveal.data.revealed} telefones revelados
          {reveal.data.withoutPhone > 0 &&
            `, ${reveal.data.withoutPhone} sem telefone na Receita`}
          .
        </p>
      ) : null}
      <ErrorBox
        error={reveal.error ?? crawl.error ?? score.error ?? flag.error ?? places.error}
      />
    </div>
  );
}
