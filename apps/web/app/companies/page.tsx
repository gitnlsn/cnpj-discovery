"use client";

import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import type { CompanyRow } from "@/lib/api-types";
import { errorMessage, nf } from "@/lib/format";
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
import { AddCompaniesSheet } from "@/components/companies/add-companies-sheet";

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
  const [detail, setDetail] = useState<CompanyRow | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    ...trpc.companies.list.queryOptions({
      projectId: projectId ?? "",
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.cnae ? { cnae: filters.cnae } : {}),
      ...(filters.uf.length === 2 ? { uf: filters.uf } : {}),
      ...(filters.flag ? { flag: filters.flag as "any" } : {}),
      ...(tri(filters.crawled) !== undefined ? { crawled: tri(filters.crawled) } : {}),
      ...(tri(filters.scored) !== undefined ? { scored: tri(filters.scored) } : {}),
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

  const exportUrl =
    `/api/export/${encodeURIComponent(pid)}` +
    (filters.flag && filters.flag !== "any" && filters.flag !== "none"
      ? `?status=${filters.flag}`
      : "");

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

      <CompanyToolbar
        projectId={pid}
        filters={filters}
        onChange={setFilters}
        onAdd={() => setAdding(true)}
        exportUrl={exportUrl}
        total={list.data?.total ?? null}
        shown={rows.length}
      />

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
        onOpen={setDetail}
        emptyAction={
          summary.data?.total === 0 ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Adicionar empresas da base
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
        onOpenChange={(open) => !open && setDetail(null)}
      />

      <AddCompaniesSheet projectId={pid} open={adding} onOpenChange={setAdding} />
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
