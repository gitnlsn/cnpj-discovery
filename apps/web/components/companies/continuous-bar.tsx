"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Infinity as InfinityIcon, Square } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage, nf } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The stop control for a continuous run.
 *
 * It lives on the companies page rather than in the dialog that started it,
 * because the run outlives the dialog — and a job you cannot see is a job you
 * cannot stop. It also refreshes the table as the count climbs, so the rows
 * appear while it works.
 */
export function ContinuousBar() {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.current ? 2000 : 5000),
  });
  const current = jobs.data?.current ?? null;
  const running = current?.kind === "continuous" ? current : null;

  const usage = useQuery(trpc.enrichment.usage.queryOptions());

  const cancel = useMutation({
    ...trpc.jobs.cancel.mutationOptions(),
    onSuccess: () => {
      toast.success("Parando após a empresa atual.");
      void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() });
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  if (!running) return null;

  const progress = (running.progress ?? null) as {
    done: number;
    note?: string;
  } | null;

  return (
    <Alert>
      <InfinityIcon className="size-4 animate-pulse" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <b>Processamento contínuo</b> em andamento ·{" "}
          <b className="tabular">{nf(progress?.done ?? 0)}</b> empresas
          {progress?.note ? ` · ${progress.note}` : ""}
          {usage.data?.llmProvider ? (
            <span className="text-muted-foreground">
              {" · "}
              {usage.data.llmProvider} · {nf(usage.data.llmRemaining)} de{" "}
              {nf(usage.data.llmDaily)} requisições hoje
            </span>
          ) : null}
        </span>
        <Button
          variant="destructive"
          size="sm"
          className="h-7"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate({ id: running.id })}
        >
          <Square className="size-3" />
          Parar processamento contínuo
        </Button>
      </AlertDescription>
    </Alert>
  );
}
