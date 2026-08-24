"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage, nf } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
import { CnaePickerDialog } from "./cnae-picker-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The three outcomes of checking a CNAE, kept apart on purpose.
 *
 * "código inventado" means the model made it up. Folding that into "sem
 * empresas" would hide the hallucination behind a plausible zero, which is
 * exactly how a fabricated segment survives review.
 */
/**
 * What a CNAE returned, or an em dash when nothing from it has been judged yet.
 *
 * The dash is load-bearing, the same way it is everywhere else here: a CNAE
 * nobody has processed and a CNAE that produced nothing are opposite facts, and
 * showing "0%" for the first would condemn a code that was never tried.
 */
function CnaeYield({
  row,
}: {
  row?: { judged: number; wrongType: number; hot: number; warm: number };
}) {
  if (!row?.judged) return <span className="text-muted-foreground">—</span>;
  const wrongPct = Math.round((100 * row.wrongType) / row.judged);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">
          <span
            className={
              wrongPct >= 50
                ? "text-destructive"
                : wrongPct >= 25
                  ? "text-muted-foreground"
                  : ""
            }
          >
            {wrongPct}% ramo errado
          </span>
          {row.hot > 0 && <span className="ml-1.5 font-medium">· {row.hot} quente</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {row.judged} julgadas · {row.wrongType} de outro ramo · {row.hot} quentes · {row.warm}{" "}
        mornas
      </TooltipContent>
    </Tooltip>
  );
}

const STATUS: Record<
  string,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  ok: { label: "existe", variant: "secondary" },
  empty: { label: "sem empresas", variant: "outline" },
  unknown: { label: "código inventado", variant: "destructive" },
};

export function CnaeTable({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  /**
   * What each CNAE returned once its companies were judged.
   *
   * Shown beside reach because the two answer different questions and only
   * together are they a decision: reach is how many companies a code offers,
   * yield is how many of the ones already tried were worth having.
   */
  const yields = useQuery(trpc.project.cnaeYield.queryOptions({ id: projectId }));

  const picks = useQuery(trpc.discovery.picks.queryOptions({ projectId }));
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: trpc.discovery.picks.queryKey({ projectId }) });

  const suggest = useMutation({
    ...trpc.discovery.suggest.mutationOptions(),
    onSuccess: (r) => {
      void invalidate();
      const bogus = r.picks.filter((p) => p.status === "unknown").length;
      toast.success(
        `${r.picks.length} CNAEs sugeridos` +
          (bogus ? ` · ${bogus} não existem na tabela oficial` : "")
      );
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });
  const setChosen = useMutation({
    ...trpc.discovery.setChosen.mutationOptions(),
    onSuccess: () => void invalidate(),
  });
  const addPick = useMutation({
    ...trpc.discovery.addPick.mutationOptions(),
    onSuccess: () => {
      setAdding(false);
      void invalidate();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  const rows = picks.data ?? [];

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm">CNAEs alvo</CardTitle>
            <CardDescription>
              Toda sugestão é conferida contra a tabela oficial e contra a contagem real antes
              de aparecer. Pedindo “ensino médio” o modelo já respondeu{" "}
              <code className="font-mono text-xs">8599</code> — que é “Formação de condutores”.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              Buscar CNAE
            </Button>
            <Button
              size="sm"
              disabled={suggest.isPending}
              onClick={() => suggest.mutate({ projectId })}
            >
              <Sparkles className="size-3.5" />
              {suggest.isPending ? "Perguntando…" : "Sugerir CNAEs"}
              <span className="text-xs opacity-70">gasta LLM</span>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="px-0">
          {picks.isLoading ? (
            <div className="space-y-2 px-6">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Nenhum CNAE escolhido"
              description="Peça sugestões ao modelo ou adicione um código à mão. Sem CNAE não há de onde tirar empresas."
            />
          ) : (
            <Table className="table-dense">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 pl-6">usar</TableHead>
                  <TableHead className="w-20">cnae</TableHead>
                  <TableHead className="w-36">situação</TableHead>
                  <TableHead className="max-w-[26rem]">descrição oficial</TableHead>
                  <TableHead className="w-24 text-right">empresas</TableHead>
                  <TableHead className="w-24 text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                          2ª ativ.
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        Empresas que registraram este CNAE como atividade SECUNDÁRIA, e não como
                        principal. Não está somado na coluna &quot;empresas&quot;: quem faz
                        disso o negócio e quem lista como atividade secundária são prospectos
                        diferentes. Travessão significa que ninguém mediu ainda — ligue
                        &quot;principal + secundária&quot; ao adicionar empresas.
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                  <TableHead className="w-24 text-right">com tel.</TableHead>
                  <TableHead className="w-24 text-right">24 meses</TableHead>
                  <TableHead className="w-28 text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                          rendeu
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        Das empresas deste CNAE que já foram julgadas: quantas o modelo aprovou
                        como sendo do ramo, e quantas viraram lead quente. Uma taxa de ramo
                        errado alta significa que o CNAE traz o tipo errado de empresa — cada
                        uma custa um crawl e uma chamada ao modelo antes de ser descartada.
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const s = STATUS[p.status] ?? STATUS.unknown!;
                  return (
                    <TableRow key={p.cnae} data-state={p.chosen ? "selected" : undefined}>
                      <TableCell className="pl-6">
                        <Checkbox
                          checked={p.chosen && p.status === "ok"}
                          disabled={p.status !== "ok"}
                          onCheckedChange={(v) =>
                            setChosen.mutate({ projectId, cnae: p.cnae, chosen: v === true })
                          }
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.cnae}</TableCell>
                      <TableCell>
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[26rem] truncate">
                        {p.descricao ? (
                          <span>{p.descricao}</span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <TriangleAlert className="size-3.5 text-destructive" />
                            não existe na tabela oficial de CNAEs
                          </span>
                        )}
                        {p.rationale && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="ml-1.5 cursor-help text-xs text-muted-foreground underline decoration-dotted">
                                por quê
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">{p.rationale}</TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right">{nf(p.reachTotal)}</TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {/* Travessão, não zero: "nunca medido" e "medido e não
                            achou ninguém" são fatos opostos, e a mesma regra que
                            a coluna "rendeu" já segue. */}
                        {p.reachSecundaria > 0 ? nf(p.reachSecundaria) : "—"}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {nf(p.reachWithPhone)}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {nf(p.reachRecent)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        <CnaeYield row={yields.data?.find((y) => y.cnae === p.cnae)} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CnaePickerDialog
        open={adding}
        onOpenChange={setAdding}
        pending={addPick.isPending}
        onPick={(cnae) => addPick.mutate({ projectId, cnae })}
      />
    </>
  );
}
