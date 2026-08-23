"use client";

import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import { errorMessage, nf } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import {
  CompanyToolbar,
  EMPTY_FILTERS,
  type Filters,
} from "@/components/companies/company-toolbar";
import { CompanyTable } from "@/components/companies/company-table";
import { CompanyDetailSheet } from "@/components/companies/company-detail-sheet";
import { SelectionBar } from "@/components/companies/selection-bar";
import { AddCompaniesDialog } from "@/components/companies/add-companies-dialog";
import { ContinuousBar } from "@/components/companies/continuous-bar";

/** "" means no opinion; the query omits the filter entirely. */
const tri = (v: string) => (v === "" ? undefined : v === "sim");

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular leading-none">{nf(value)}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function CompaniesPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * The open sheet is addressed by CNPJ, not by the row object.
   *
   * Holding the row itself froze it at the moment of the click: a mutation could
   * invalidate the list, the table behind would update, and the sheet would go
   * on showing the score from before. That is fatal for the sheet's own
   * re-score button, whose whole purpose is to show you what changed.
   */
  const [detailCnpj, setDetailCnpj] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    ...trpc.companies.list.queryOptions({
      projectId: projectId ?? "",
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.cnae ? { cnae: filters.cnae } : {}),
      ...(filters.uf.length === 2 ? { uf: filters.uf } : {}),
      ...(filters.flags.length ? { flags: filters.flags } : {}),
      ...(tri(filters.crawled) !== undefined ? { crawled: tri(filters.crawled) } : {}),
      // "" is the default and means processadas; "todas" opts out entirely.
      ...(filters.situacao === "todas" ? {} : { processed: filters.situacao !== "nao" }),
      order: filters.order,
      limit: 300,
    }),
    enabled: Boolean(projectId),
  });
  const summary = useQuery({
    ...trpc.companies.summary.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const refreshAll = () => void qc.invalidateQueries();
  const fail = (e: unknown) => toast.error(errorMessage(e) ?? "Falhou.");

  // Single-row versions of the batch verbs, for the row menu.
  const reveal = useMutation({
    ...trpc.enrichment.revealPhoneBatch.mutationOptions(),
    onSuccess: (r) => {
      refreshAll();
      toast.success(
        r.revealed ? "Telefone revelado." : "A Receita não tem telefone para esta empresa."
      );
    },
    onError: fail,
  });
  const crawlOne = useMutation({
    ...trpc.enrichment.crawlBatch.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
    onError: fail,
  });
  const scoreOne = useMutation({
    ...trpc.scoring.run.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.jobs.status.queryKey() }),
    onError: fail,
  });
  const flagOne = useMutation({
    ...trpc.leads.flag.mutationOptions(),
    onSuccess: () => {
      refreshAll();
      toast.success("Marcada como lead.");
    },
    onError: fail,
  });
  const removeOne = useMutation({
    ...trpc.companies.remove.mutationOptions(),
    onSuccess: () => {
      refreshAll();
      toast.success("Removida do projeto.");
    },
    onError: fail,
  });

  const meiPending = useQuery({
    ...trpc.enrichment.meiPending.queryOptions({ projectId: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const reprocessMei = useMutation({
    ...trpc.enrichment.reprocessMei.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (!r.jobId) {
        toast.info("Nada a reprocessar: todas já foram buscadas uma vez.");
        return;
      }
      toast.success(
        `Procurando presença de ${r.queued} — depois pontuo as que ganharem evidência. ` +
          `Se o Google pedir CAPTCHA, a janela do Chrome abre para você resolver.`
      );
    },
    onError: fail,
  });

  if (!projectId) {
    return (
      <Card>
        <EmptyState
          icon={FolderKanban}
          title="Nenhum projeto escolhido"
          description="As empresas são escopadas por projeto. Escolha um no seletor acima."
        />
      </Card>
    );
  }

  const rows = list.data?.rows ?? [];
  const pid = projectId;
  // Re-resolved on every render, so the sheet always shows the current row.
  const detail = rows.find((r) => r.company.cnpj === detailCnpj) ?? null;

  // The CSV is the list, not a separate report: it carries whatever the toolbar
  // is filtering by, so the file matches what is on screen.
  const exportParams = new URLSearchParams([
    ...Object.entries({
      q: filters.q,
      cnae: filters.cnae,
      uf: filters.uf.length === 2 ? filters.uf : "",
      crawled: filters.crawled,
      situacao: filters.situacao,
      order: filters.order,
    }).filter(([, v]) => v !== ""),
    // Repeated rather than joined: one key per chosen state.
    ...filters.flags.map((f) => ["flag", f]),
  ]).toString();
  const exportUrl =
    `/api/export/${encodeURIComponent(pid)}` + (exportParams ? `?${exportParams}` : "");

  return (
    <div className="space-y-3 pb-24">
      <div className="flex flex-wrap items-center gap-6">
        <h1 className="text-lg font-semibold tracking-tight">Empresas</h1>
        <div className="flex flex-wrap items-center gap-6">
          <Stat label="no projeto" value={summary.data?.total ?? null} />
          <Stat label="site lido" value={summary.data?.crawled ?? null} />
          <Stat label="pontuadas" value={summary.data?.scored ?? null} />
          <Stat label="marcadas" value={summary.data?.flagged ?? null} />
        </div>
      </div>

      <ContinuousBar />

      <CompanyToolbar
        projectId={pid}
        filters={filters}
        onChange={setFilters}
        onAdd={() => setAdding(true)}
        exportUrl={exportUrl}
        total={list.data?.total ?? null}
        shown={rows.length}
      />

      {summary.data && summary.data.pending > 0 && filters.situacao === "" && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              <b className="tabular">{nf(summary.data.pending)}</b>{" "}
              {summary.data.pending === 1
                ? "empresa ainda não foi"
                : "empresas ainda não foram"}{" "}
              processada{summary.data.pending === 1 ? "" : "s"} e{" "}
              {summary.data.pending === 1 ? "está" : "estão"} fora desta lista.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setFilters({ ...filters, situacao: "nao" })}
            >
              Ver
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/*
        The MEI dead-end cohort.
        
        Shown as a banner rather than tucked into a menu because the action
        spends a scarce, self-imposed daily quota and can pause on a CAPTCHA.
        The count is the point: nobody should trigger a scraping run without
        first seeing how many companies it will touch. When the number is zero
        the banner disappears entirely.
      */}
      {meiPending.data && meiPending.data.searchable > 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>
              <b className="tabular">{nf(meiPending.data.total)}</b> MEI
              {meiPending.data.total === 1 ? "" : "s"} sem conclusão — a Receita não tem site
              delas, então a nota não saiu. Dá para procurar o nome do dono na web e pontuar de
              novo{" "}
              {meiPending.data.searchable < meiPending.data.total && (
                <span className="text-muted-foreground">
                  ({nf(meiPending.data.searchable)} com nome verificável)
                </span>
              )}
              .
            </span>
            {meiPending.data.enabled ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                disabled={reprocessMei.isPending || meiPending.data.remaining === 0}
                onClick={() => reprocessMei.mutate({ projectId: pid })}
              >
                {meiPending.data.remaining === 0
                  ? "sem busca hoje"
                  : `Procurar e pontuar (${nf(Math.min(meiPending.data.searchable, meiPending.data.remaining))})`}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                ligue com SERP_ENABLED=1 para procurar na web
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      <CompanyTable
        rows={rows}
        loading={list.isLoading}
        selected={selected}
        onToggle={(cnpj) =>
          setSelected((s) => {
            const next = new Set(s);
            if (next.has(cnpj)) next.delete(cnpj);
            else next.add(cnpj);
            return next;
          })
        }
        onToggleAll={(checked) =>
          setSelected(checked ? new Set(rows.map((r) => r.company.cnpj)) : new Set())
        }
        onOpen={(r) => setDetailCnpj(r.company.cnpj)}
        emptyAction={
          summary.data?.total === 0 ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Adicionar empresas da base
            </Button>
          ) : filters.situacao === "" && summary.data?.pending ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFilters({ ...filters, situacao: "nao" })}
            >
              Ver as {nf(summary.data.pending)} que faltam processar
            </Button>
          ) : undefined
        }
        handlers={{
          onReveal: (cnpj) => reveal.mutate({ cnpjs: [cnpj] }),
          onCrawl: (cnpj) => crawlOne.mutate({ projectId: pid, cnpjs: [cnpj], depth: 0 }),
          onScore: (cnpj) => scoreOne.mutate({ projectId: pid, cnpjs: [cnpj], batchSize: 1 }),
          onFlag: (cnpj) => flagOne.mutate({ projectId: pid, cnpjs: [cnpj] }),
          onRemove: (cnpj) => removeOne.mutate({ projectId: pid, cnpjs: [cnpj] }),
        }}
      />

      <SelectionBar
        projectId={pid}
        selected={[...selected]}
        onClear={() => setSelected(new Set())}
      />

      <CompanyDetailSheet
        projectId={pid}
        row={detail}
        onOpenChange={(open) => !open && setDetailCnpj(null)}
      />

      <AddCompaniesDialog projectId={pid} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <CompaniesPage />
    </Suspense>
  );
}
