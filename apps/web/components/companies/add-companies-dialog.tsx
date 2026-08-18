"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Search } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage, nf } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Order = "founded-desc" | "founded-asc" | "name" | "capital-desc";

/**
 * Search the Receita base and pull companies into the project.
 *
 * A centred modal, not a panel wedged into the page. This is the only place
 * anything from the 12M-row Parquet base is written to the app's own database,
 * and it is a decision you make in one sitting — so it gets the middle of the
 * screen and enough width for the columns to breathe, rather than a side panel
 * that squeezes the table into overlapping text.
 *
 * Only the project's chosen CNAEs are offered, so a code the model invented
 * cannot reach here — it was already refused on the project tab.
 */
export function AddCompaniesDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [order, setOrder] = useState<Order>("founded-desc");
  const [uf, setUf] = useState("");
  const [foundedFrom, setFoundedFrom] = useState("");
  const [hasPhone, setHasPhone] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const picks = useQuery({
    ...trpc.discovery.picks.queryOptions({ projectId }),
    enabled: open,
  });
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
    enabled: open && chosen.length > 0,
  });
  const reach = useQuery({
    ...trpc.discovery.reach.queryOptions({ filters }),
    enabled: open && chosen.length > 0,
  });

  const runPipeline = useMutation({
    ...trpc.companies.process.mutationOptions(),
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  const add = useMutation({
    ...trpc.discovery.addCompanies.mutationOptions(),
    onSuccess: (r, vars) => {
      void qc.invalidateQueries();
      const n = r.added;
      if (process && n > 0) {
        runPipeline.mutate({ projectId, cnpjs: vars.cnpjs, depth: 0 });
        toast.success(`${n} adicionada${n === 1 ? "" : "s"} · visitando os sites e pontuando`);
      } else {
        toast.success(`${n} empresa${n === 1 ? "" : "s"} adicionada${n === 1 ? "" : "s"}.`);
      }
      setPicked(new Set());
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  const rows = results.data ?? [];
  const toggle = (cnpj: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(cnpj)) next.delete(cnpj);
      else next.add(cnpj);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92svh] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        style={{ width: "min(72rem, 94vw)" }}
      >
        <DialogHeader className="border-b px-6 py-4 pr-12">
          <DialogTitle>Adicionar empresas da base</DialogTitle>
          <DialogDescription>
            {reach.data ? (
              <>
                <b className="tabular">{nf(reach.data.total)}</b> empresas nos CNAEs escolhidos
                · <span className="tabular">{nf(reach.data.withPhone)}</span> com telefone ·{" "}
                <span className="tabular">{nf(reach.data.recent)}</span> abertas nos últimos 24
                meses
              </>
            ) : (
              "Busca na base local da Receita. Nada é gravado até você adicionar."
            )}
          </DialogDescription>
        </DialogHeader>

        {chosen.length === 0 ? (
          <EmptyState
            icon={Database}
            title="Nenhum CNAE escolhido"
            description="Vá em Projetos → CNAEs, peça sugestões ou adicione um código, e marque os que quer usar."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2 border-b px-6 py-3">
              <div className="grid gap-1">
                <Label className="text-xs">Ordem</Label>
                <Select value={order} onValueChange={(v) => setOrder(v as Order)}>
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="founded-desc">mais novas primeiro</SelectItem>
                    <SelectItem value="founded-asc">mais antigas primeiro</SelectItem>
                    <SelectItem value="name">nome</SelectItem>
                    <SelectItem value="capital-desc">maior capital</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="a-uf" className="text-xs">
                  UF
                </Label>
                <Input
                  id="a-uf"
                  value={uf}
                  maxLength={2}
                  placeholder="SP"
                  onChange={(e) => setUf(e.target.value.toUpperCase())}
                  className="h-8 w-16"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="a-from" className="text-xs">
                  Abertas a partir de
                </Label>
                <Input
                  id="a-from"
                  value={foundedFrom}
                  placeholder="2025-01-01"
                  onChange={(e) => setFoundedFrom(e.target.value)}
                  className="h-8 w-32 font-mono"
                />
              </div>
              <label className="flex h-8 items-center gap-1.5 text-sm">
                <Checkbox checked={hasPhone} onCheckedChange={(v) => setHasPhone(v === true)} />
                só com telefone
              </label>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={rows.length === 0}
                onClick={() => setPicked(new Set(rows.map((r) => r.cnpj)))}
              >
                Selecionar os {rows.length}
              </Button>
            </div>

            <ScrollArea className="h-[52svh]">
              {results.isLoading ? (
                <div className="space-y-1.5 p-4">
                  {Array.from({ length: 10 }, (_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="Nenhuma empresa com esses filtros"
                  description="Afrouxe a UF, a data de abertura, ou desmarque “só com telefone”."
                />
              ) : (
                <Table className="table-dense">
                  <TableHeader className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
                    <TableRow>
                      <TableHead className="w-9" />
                      <TableHead className="min-w-[20rem]">nome</TableHead>
                      <TableHead className="w-20">cnae</TableHead>
                      <TableHead className="w-32">local</TableHead>
                      <TableHead className="w-24">aberta</TableHead>
                      <TableHead className="w-36">telefone</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((c) => (
                      <TableRow
                        key={c.cnpj}
                        data-state={picked.has(c.cnpj) ? "selected" : undefined}
                        onClick={() => toggle(c.cnpj)}
                        className="cursor-pointer"
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={picked.has(c.cnpj)}
                            onCheckedChange={() => toggle(c.cnpj)}
                          />
                        </TableCell>
                        <TableCell className="max-w-[26rem]">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">
                              {c.nomeFantasia ?? c.razaoSocial ?? (
                                <span className="text-muted-foreground">(sem nome)</span>
                              )}
                            </span>
                            {c.mei && (
                              <Badge variant="outline" className="shrink-0 text-[10px]">
                                MEI
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.cnae}</TableCell>
                        <TableCell className="text-xs">
                          {c.municipio ?? "?"}/{c.uf}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {c.dataInicioAtividade ?? "—"}
                        </TableCell>
                        <TableCell>
                          {c.phone ? (
                            <span className="font-mono text-xs">
                              {c.phone.e164}
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                {c.phone.isMobile ? "cel" : "fixo"}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </ScrollArea>

            {/*
              A plain div, not DialogFooter. That component ships `-mx-4 -mb-4`
              sized for the default `p-4` on DialogContent — with `p-0` here the
              negative margins dragged it out of the container and it rendered
              on top of the last rows. It also fights `px-6` with its own `p-4`.
              It was only contributing a border and a flex row.
            */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-muted/50 px-6 py-3">
              <p className="text-xs text-muted-foreground">
                Ao adicionar, o site de cada uma é visitado e a empresa é pontuada — é o que faz
                a linha aparecer na lista.
                <span className="ml-1">
                  grátis + gasta LLM · ~{Math.ceil(picked.size / 10)} req
                </span>
              </p>
              <div className="flex items-center gap-3">
                <span className="tabular text-sm text-muted-foreground">
                  {picked.size} selecionada{picked.size === 1 ? "" : "s"}
                </span>
                <Button
                  disabled={picked.size === 0 || add.isPending}
                  onClick={() =>
                    add.mutate({ projectId, cnpjs: [...picked], sourcePeriod: "2026-08" })
                  }
                >
                  {add.isPending ? "Adicionando…" : `Adicionar e processar ${picked.size}`}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
