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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
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
  const [code, setCode] = useState("");

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
      setCode("");
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
              Código
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
                  <TableHead className="w-24 text-right">com tel.</TableHead>
                  <TableHead className="w-24 text-right">24 meses</TableHead>
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
                        {nf(p.reachWithPhone)}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {nf(p.reachRecent)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Adicionar CNAE</DialogTitle>
            <DialogDescription>
              Código ou prefixo, só dígitos. Um prefixo de dois dígitos como{" "}
              <code className="font-mono text-xs">85</code> pega toda a divisão.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            inputMode="numeric"
            placeholder="8520100"
            value={code}
            className="font-mono"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 7))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.length >= 2) {
                addPick.mutate({ projectId, cnae: code });
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button
              disabled={code.length < 2 || addPick.isPending}
              onClick={() => addPick.mutate({ projectId, cnae: code })}
            >
              Adicionar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
