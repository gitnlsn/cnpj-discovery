"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Square } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage, nf } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

/**
 * What the open-internet lane is doing, and the button that stops it.
 *
 * It exists because its absence was a dead end: the lane allows one job at a
 * time, so every button on the tab answered "já existe uma varredura rodando"
 * while the page showed nothing running and offered no way to stop it. A job you
 * cannot see is a job you cannot cancel.
 *
 * The log tail is here, and not only in some detail view, because these runs are
 * long — a re-crawl of 34 sites at up to 15 pages each is minutes, not seconds —
 * and a spinner with no words cannot be told from a hang.
 *
 * Polling `jobs.status` also does something invisible but load-bearing: it is what
 * triggers `reconcileStaleJobs`, which clears a `running` row orphaned by a dev
 * server restart. With no caller on this page, such a row would hold the lane
 * forever and every button would go on refusing.
 */
export function SweepBar() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.openWeb ? 2000 : 6000),
  });
  const running = jobs.data?.openWeb ?? null;

  const cancel = useMutation({
    ...trpc.jobs.cancel.mutationOptions(),
    onSuccess: () => {
      toast.success("Parando depois do site atual.");
      void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() });
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  if (!running) return null;

  const progress = (running.progress ?? null) as {
    done: number;
    total: number;
    note?: string;
  } | null;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  // The discovery phase has no honest denominator, so the bar only appears when
  // there is one — the same reasoning the continuous run's progress follows.
  const pct = total > 0 && total >= done ? Math.round((done / total) * 100) : null;
  const tail = (running.log ?? "").trim().split("\n").slice(-4);

  return (
    <Alert>
      <Globe className="size-4 animate-pulse" />
      <AlertDescription className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            <b>Varredura da internet aberta</b> em andamento ·{" "}
            <b className="tabular">{nf(done)}</b>
            {total > 0 ? <span className="tabular"> de {nf(total)}</span> : null}
            {progress?.note ? ` · ${progress.note}` : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => cancel.mutate({ id: running.id })}
            disabled={cancel.isPending}
          >
            <Square className="size-3.5" /> Parar
          </Button>
        </div>

        {pct !== null && <Progress value={pct} className="h-1.5" />}

        {tail.length > 0 && (
          <pre className="max-h-24 overflow-y-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {tail.join("\n")}
          </pre>
        )}
      </AlertDescription>
    </Alert>
  );
}
