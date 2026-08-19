"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Flag,
  Globe,
  MapPin,
  MoreHorizontal,
  Phone,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage } from "@/lib/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * What you can run over the selected rows.
 *
 * It only exists while something is selected. The previous version kept six
 * buttons on screen permanently, almost all of them disabled almost all of the
 * time, which is constant noise that teaches you to stop reading the bar.
 *
 * Every button still carries its cost, because free versus paid is the one
 * thing you cannot undo.
 */
export function SelectionBar({
  projectId,
  selected,
  onClear,
}: {
  projectId: string;
  selected: string[];
  onClear: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [depth, setDepth] = useState("0");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const n = selected.length;

  // Poll fast while something runs, slowly otherwise — never `false`. Stopping
  // when idle means a job started anywhere else (another tab, or this page
  // reloaded mid-run) can never be discovered, and the bar silently never
  // appears for work that is genuinely in flight.
  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.current ? 1200 : 5000),
  });
  // A continuous run has its own bar with its own stop button; showing it here
  // too would give two controls for one job, and this one would call it
  // "pontuando" when it is doing rather more than that.
  const currentJob = jobs.data?.current ?? null;
  const running = currentJob?.kind === "continuous" ? null : currentJob;
  const progress = (running?.progress ?? null) as { done: number; total: number } | null;
  const usage = useQuery(trpc.enrichment.usage.queryOptions());

  const refreshJobs = () =>
    void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() });
  const fail = (e: unknown) => toast.error(errorMessage(e) ?? "Falhou.");

  const reveal = useMutation({
    ...trpc.enrichment.revealPhoneBatch.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(
        `${r.revealed} telefone${r.revealed === 1 ? "" : "s"} revelado${r.revealed === 1 ? "" : "s"}` +
          (r.withoutPhone ? ` · ${r.withoutPhone} sem telefone na Receita` : "")
      );
    },
    onError: fail,
  });

  const crawl = useMutation({
    ...trpc.enrichment.crawlBatch.mutationOptions(),
    onSuccess: (r) => {
      refreshJobs();
      if (r.skipped) {
        toast.info(
          `${r.skipped} sem site conhecido — o e-mail é gmail, ou é do contador. Tente o Places nessas.`
        );
      }
    },
    onError: fail,
  });

  // Crawl then score, in that order, as one job — the order is load-bearing and
  // doing it by hand means waiting for one to finish to start the other.
  const pipeline = useMutation({
    ...trpc.companies.process.mutationOptions(),
    onSuccess: refreshJobs,
    onError: fail,
  });

  const score = useMutation({
    ...trpc.scoring.run.mutationOptions(),
    onSuccess: refreshJobs,
    onError: fail,
  });

  const flag = useMutation({
    ...trpc.leads.flag.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.flagged} marcada${r.flagged === 1 ? "" : "s"} como lead.`);
      onClear();
    },
    onError: fail,
  });

  const places = useMutation({
    ...trpc.enrichment.placesBatch.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(
        `Places: ${r.looked} consultadas, ${r.withSite} com site.` +
          (r.stoppedOnQuota ? " Parei na cota gratuita — o que já foi feito está salvo." : "")
      );
    },
    onError: fail,
  });

  const remove = useMutation({
    ...trpc.companies.remove.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`${r.removed} removida${r.removed === 1 ? "" : "s"} do projeto.`);
      setConfirmRemove(false);
      onClear();
    },
    onError: fail,
  });

  const cancel = useMutation({
    ...trpc.jobs.cancel.mutationOptions(),
    onSuccess: refreshJobs,
  });

  if (n === 0 && !running) return null;

  const busy = Boolean(running);
  const quotaLeft = usage.data?.placesRemaining ?? 0;
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
        <div className="pointer-events-auto flex max-w-[min(64rem,100%)] flex-wrap items-center gap-2 rounded-lg border bg-popover/95 p-2 shadow-lg backdrop-blur">
          {n > 0 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onClear}
                aria-label="Limpar seleção"
              >
                <X className="size-3.5" />
              </Button>
              <span className="text-sm font-medium tabular">
                {n} selecionada{n === 1 ? "" : "s"}
              </span>
              <Separator orientation="vertical" className="h-6" />

              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={reveal.isPending}
                onClick={() => reveal.mutate({ cnpjs: selected })}
              >
                <Phone className="size-3.5" />
                Telefone
                <span className="text-xs opacity-60">grátis</span>
              </Button>

              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={busy}
                  onClick={() =>
                    crawl.mutate({
                      projectId,
                      cnpjs: selected,
                      depth: Number(depth),
                      concurrency: 6,
                    })
                  }
                >
                  <Globe className="size-3.5" />
                  Visitar site
                  <span className="text-xs opacity-60">grátis</span>
                </Button>
                <Select value={depth} onValueChange={setDepth}>
                  <SelectTrigger className="h-8 w-[7.5rem]" aria-label="Profundidade">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">só a home</SelectItem>
                    <SelectItem value="2">+2 páginas</SelectItem>
                    <SelectItem value="4">+4 páginas</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={busy}
                onClick={() => score.mutate({ projectId, cnpjs: selected, batchSize: 10 })}
              >
                <Sparkles className="size-3.5" />
                Pontuar
                <span className="text-xs opacity-60">gasta LLM · ~{Math.ceil(n / 10)} req</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={busy}
                onClick={() =>
                  pipeline.mutate({
                    projectId,
                    cnpjs: selected,
                    depth: Number(depth),
                    concurrency: 6,
                  })
                }
              >
                <Wand2 className="size-3.5" />
                Visitar e pontuar
                <span className="text-xs opacity-60">
                  grátis + LLM · ~{Math.ceil(n / 10)} req
                </span>
              </Button>

              <Button
                size="sm"
                className="h-8"
                disabled={flag.isPending}
                onClick={() => flag.mutate({ projectId, cnpjs: selected })}
              >
                <Flag className="size-3.5" />
                Marcar como lead
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Mais ações"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Gasta cota paga
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={
                      !usage.data?.placesConfigured || quotaLeft === 0 || places.isPending
                    }
                    onClick={() =>
                      places.mutate({ projectId, cnpjs: selected, allowPaid: true })
                    }
                  >
                    <MapPin className="size-3.5" />
                    Buscar site no Places
                    <span className="ml-auto text-xs text-muted-foreground">
                      {usage.data?.placesConfigured
                        ? `${quotaLeft}/${usage.data.placesMonthly}`
                        : "sem chave"}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmRemove(true)}
                  >
                    <Trash2 className="size-3.5" />
                    Remover do projeto
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {running && (
            <>
              {n > 0 && <Separator orientation="vertical" className="h-6" />}
              <div className="flex min-w-[13rem] items-center gap-2">
                <div className="flex-1 space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {running.kind === "crawl"
                      ? "visitando sites"
                      : running.kind === "pipeline"
                        ? "visitando e pontuando"
                        : "pontuando"}
                    {progress ? ` · ${progress.done}/${progress.total}` : "…"}
                  </p>
                  <Progress value={pct} className="h-1.5" />
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      onClick={() => cancel.mutate({ id: running.id })}
                    >
                      Cancelar
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Para entre os lotes. O que já foi feito fica salvo.
                  </TooltipContent>
                </Tooltip>
              </div>
            </>
          )}
        </div>
      </div>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remover {n} empresa{n === 1 ? "" : "s"} do projeto?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A marcação de lead e as anotações dessas empresas vão junto. O crawl e a nota
              continuam no banco, e voltam se você adicionar a empresa de novo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ projectId, cnpjs: selected })}>
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
