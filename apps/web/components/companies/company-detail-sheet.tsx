"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageCircle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import type { CompanyRow } from "@/lib/api-types";
import {
  LEAD_LABEL,
  LEAD_STATUSES,
  TIER_CLASS,
  dateBr,
  errorMessage,
  maybe,
  type LeadStatus,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

/**
 * Everything known about one company.
 *
 * A Sheet rather than a route so the table keeps its scroll position and your
 * selection while you skim down a list. It also gives the score's justification
 * and evidence somewhere to live — that text has always been stored and
 * returned, and until now there was nowhere on screen to read it.
 */
export function CompanyDetailSheet({
  projectId,
  row,
  onOpenChange,
}: {
  projectId: string;
  row: CompanyRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [impression, setImpression] = useState("");
  /**
   * The score as it stood just before a re-run, so the sheet can show what moved.
   *
   * Session-only, on purpose: `scores` keeps one row per company and a re-run
   * overwrites it, so there is no persisted "before". Holding it here says that
   * honestly — it is gone on reload, because it was never saved.
   */
  const [previous, setPrevious] = useState<{
    bestFit: number | null;
    tier: "hot" | "warm" | "cold" | null;
  } | null>(null);

  useEffect(() => setNotes(row?.lead?.notes ?? ""), [row?.lead?.notes, row?.company.cnpj]);
  useEffect(() => {
    setImpression(row?.impression?.body ?? "");
    setPrevious(null);
  }, [row?.impression?.body, row?.company.cnpj]);

  const setStatus = useMutation({
    ...trpc.leads.setStatus.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });
  const setNotesMut = useMutation({
    ...trpc.leads.setNotes.mutationOptions(),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success("Anotação salva.");
    },
  });
  const flag = useMutation({
    ...trpc.leads.flag.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const setImpressionMut = useMutation({
    ...trpc.impressions.set.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries(),
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });
  const rescore = useMutation({
    ...trpc.scoring.rescoreOne.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.error) toast.error(`A chamada falhou: ${r.error}`);
      else toast.success("Pontuada de novo com a sua impressão.");
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  if (!row) return null;
  const { company: c, crawl, score, lead, contacts, places, guessedSite } = row;
  const s = crawl?.signals;
  const evidence = score?.evidence as { evidence?: string[]; justification?: string } | null;
  const fits = (score?.fits ?? null) as Record<string, number | null> | null;

  const stored = row.impression;
  const dirty = impression.trim() !== (stored?.body ?? "");
  /**
   * Whether the grade on screen has seen what you wrote.
   *
   * Two timestamps, no new column: once the impression row exists, every
   * scoring path reads it, so a score stamped after it necessarily included it.
   */
  const staleScore = Boolean(stored && score?.scoredAt && score.scoredAt < stored.updatedAt);
  const busy = setImpressionMut.isPending || rescore.isPending;

  const saveImpression = () =>
    setImpressionMut.mutate({ projectId, cnpj: c.cnpj, body: impression });

  /** Saved first, then scored: the prompt is built from the row, not from state. */
  const saveAndRescore = async () => {
    setPrevious({ bestFit: score?.bestFit ?? null, tier: score?.tier ?? null });
    try {
      if (dirty) {
        await setImpressionMut.mutateAsync({ projectId, cnpj: c.cnpj, body: impression });
      }
      await rescore.mutateAsync({ projectId, cnpj: c.cnpj });
    } catch {
      // Both mutations already toast; nothing useful to add here.
      setPrevious(null);
    }
  };

  return (
    <Sheet open={Boolean(row)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b">
          <SheetTitle className="pr-6 leading-tight">
            {c.nomeFantasia ?? c.razaoSocial ?? c.cnpj}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{c.cnpj}</SheetDescription>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {score?.tier && (
              <Badge className={cn("uppercase", TIER_CLASS[score.tier])}>
                {score.tier} · {maybe(score.bestFit)}
              </Badge>
            )}
            {score?.wrongType && <Badge variant="destructive">ramo errado</Badge>}
            {lead && <Badge variant="outline">{LEAD_LABEL[lead.status]}</Badge>}
            {c.mei && <Badge variant="secondary">MEI</Badge>}
          </div>
        </SheetHeader>

        <Tabs defaultValue={score ? "pontuacao" : "cadastro"} className="min-h-0 flex-1">
          <TabsList className="mx-4 mt-3">
            <TabsTrigger value="cadastro">Cadastro</TabsTrigger>
            <TabsTrigger value="site">Site</TabsTrigger>
            <TabsTrigger value="pontuacao">Pontuação</TabsTrigger>
            <TabsTrigger value="lead">Lead</TabsTrigger>
          </TabsList>

          <ScrollArea className="h-[calc(100svh-11rem)]">
            <div className="px-4 pb-8">
              <TabsContent value="cadastro">
                <dl className="divide-y">
                  <Field label="Razão social">{c.razaoSocial ?? DASH}</Field>
                  <Field label="Nome fantasia">{c.nomeFantasia ?? DASH}</Field>
                  <Field label="CNAE">
                    <span className="font-mono text-xs">{c.cnae}</span>
                    {c.cnaeDescricao && <span className="ml-2">{c.cnaeDescricao}</span>}
                  </Field>
                  <Field label="Endereço">
                    {c.endereco ? (
                      <>
                        <span>{c.endereco.linha}</span>
                        <a
                          href={c.endereco.maps}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-xs underline underline-offset-2 hover:no-underline"
                        >
                          ver no mapa
                        </a>
                      </>
                    ) : (
                      DASH
                    )}
                  </Field>
                  <Field label="Local">
                    {[c.bairro, c.municipio, c.uf].filter(Boolean).join(" · ") || DASH}
                    {c.cep && <span className="ml-2 font-mono text-xs">{c.cep}</span>}
                  </Field>
                  <Field label="Aberta em">
                    <span className="font-mono text-xs">{c.dataInicioAtividade ?? "—"}</span>
                  </Field>
                  <Field label="Porte">{c.porte ?? DASH}</Field>
                  <Field label="Capital social">
                    {c.capitalSocial == null
                      ? DASH
                      : c.capitalSocial.toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                        })}
                  </Field>
                  <Field label="Regime">
                    {[c.mei && "MEI", c.simples && "Simples"].filter(Boolean).join(" · ") ||
                      DASH}
                  </Field>
                  <Field label="E-mail">{c.email ?? DASH}</Field>
                  <Field label="Telefones">
                    {contacts.length === 0 ? (
                      <span className="text-muted-foreground">
                        não revelado — use “Revelar telefone”
                      </span>
                    ) : (
                      <ul className="space-y-1">
                        {contacts.map((p) => (
                          <li key={p.phoneE164} className="flex items-center gap-1.5">
                            <a
                              href={p.waMe ?? "#"}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="font-mono text-xs underline-offset-2 hover:underline"
                            >
                              {p.phoneE164}
                            </a>
                            <Badge variant="outline" className="text-[10px]">
                              {p.isMobile ? "celular" : "fixo"}
                            </Badge>
                            {p.source === "site" && (
                              <Badge variant="secondary" className="text-[10px]">
                                do site
                              </Badge>
                            )}
                            <MessageCircle className="size-3 text-muted-foreground" />
                          </li>
                        ))}
                      </ul>
                    )}
                  </Field>
                  <Field label="Snapshot">
                    <span className="font-mono text-xs">{c.sourcePeriod ?? "—"}</span>
                  </Field>
                </dl>
              </TabsContent>

              <TabsContent value="site">
                {!crawl ? (
                  <p className="py-6 text-sm text-muted-foreground">
                    Site nunca visitado.
                    {guessedSite ? (
                      <>
                        {" "}
                        O palpite pelo e-mail seria{" "}
                        <span className="font-mono text-xs">{guessedSite}</span>.
                      </>
                    ) : places?.websiteUrl ? (
                      <>
                        {" "}
                        O Places achou{" "}
                        <span className="font-mono text-xs">{places.websiteUrl}</span>.
                      </>
                    ) : (
                      " Nenhum site conhecido."
                    )}
                  </p>
                ) : (
                  <dl className="divide-y">
                    <Field label="URL final">
                      {crawl.finalUrl ? (
                        <a
                          href={crawl.finalUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 break-all underline-offset-2 hover:underline"
                        >
                          {crawl.finalUrl}
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ) : (
                        DASH
                      )}
                    </Field>
                    <Field label="Como foi achado">
                      <Badge variant="outline">{crawl.urlSource ?? "—"}</Badge>
                    </Field>
                    <Field label="Resultado">
                      {crawl.error ? (
                        <span className="flex items-center gap-1.5 text-destructive">
                          <TriangleAlert className="size-3.5" />
                          {crawl.error}
                        </span>
                      ) : (
                        <>
                          HTTP {crawl.httpStatus} · {crawl.pagesFetched} página
                          {crawl.pagesFetched === 1 ? "" : "s"}
                        </>
                      )}
                    </Field>
                    <Field label="Título">{s?.title ?? DASH}</Field>
                    <Field label="Sinais">
                      <div className="flex flex-wrap gap-1">
                        {s?.isLinkHub && <Badge variant="secondary">link na bio</Badge>}
                        {s?.isFreeBuilder && (
                          <Badge variant="secondary">construtor grátis</Badge>
                        )}
                        {s?.isDead && <Badge variant="destructive">fora do ar</Badge>}
                        {s?.platform && <Badge variant="outline">{s.platform}</Badge>}
                        {s?.hasViewport === false && (
                          <Badge variant="secondary">não responsivo</Badge>
                        )}
                        {s?.hasWaLink && <Badge variant="outline">link de WhatsApp</Badge>}
                        {s?.hasContactPath === false && (
                          <Badge variant="secondary">sem contato</Badge>
                        )}
                        {s?.footerYear && (
                          <Badge variant="outline">rodapé {s.footerYear}</Badge>
                        )}
                        {s?.igHandle && <Badge variant="outline">@{s.igHandle}</Badge>}
                      </div>
                    </Field>
                    {s?.probes && Object.keys(s.probes).length > 0 && (
                      <Field label="Sinais buscados">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(s.probes).map(([k, hit]) => (
                            <Badge key={k} variant={hit ? "default" : "outline"}>
                              {hit ? "✓" : "✗"} {k}
                            </Badge>
                          ))}
                        </div>
                      </Field>
                    )}
                    <Field label="Visitado em">{dateBr(crawl.checkedAt)}</Field>
                    {crawl.textExcerpt && (
                      <div className="pt-3">
                        <p className="mb-1 text-sm text-muted-foreground">
                          Texto lido ({crawl.textExcerpt.length} caracteres)
                        </p>
                        <p className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs leading-relaxed">
                          {crawl.textExcerpt}
                        </p>
                      </div>
                    )}
                  </dl>
                )}
              </TabsContent>

              <TabsContent value="pontuacao" className="space-y-4">
                {!score ? (
                  <p className="py-6 text-sm text-muted-foreground">Ainda não pontuada.</p>
                ) : !score.model && !score.error ? (
                  <div className="space-y-2 py-4">
                    <Badge variant="outline">não pontuada — sem site</Badge>
                    <p className="text-sm text-muted-foreground">
                      Nenhuma página foi lida, então não havia evidência para pontuar. Nenhuma
                      chamada ao modelo foi gasta.
                    </p>
                    <p className="text-sm">
                      Para pontuar mesmo assim, use “Pontuar” na linha — pedir explicitamente é
                      honrado.
                    </p>
                  </div>
                ) : score.error ? (
                  <div className="space-y-2 py-4">
                    <Badge variant="destructive">a chamada falhou</Badge>
                    <p className="text-sm text-muted-foreground">{score.error}</p>
                    <p className="text-sm">
                      A nota ficou <b>vazia</b> de propósito. Um 5 inventado ficaria acima dos 4
                      verdadeiros para sempre, sem nada indicar que foi chute.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4 pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {score.tier && (
                        <Badge className={cn("uppercase", TIER_CLASS[score.tier])}>
                          {score.tier}
                        </Badge>
                      )}
                      <span className="text-2xl font-semibold tabular">
                        {maybe(score.bestFit)}
                      </span>
                      <Badge variant={score.confidence === "high" ? "secondary" : "outline"}>
                        confiança: {score.confidence ?? "—"}
                      </Badge>
                      {score.recommendation && (
                        <Badge variant="outline">{score.recommendation}</Badge>
                      )}
                      {staleScore && (
                        <Badge variant="outline">impressão nova — pontue de novo</Badge>
                      )}
                    </div>

                    {previous && !rescore.isPending && (
                      <p className="text-xs text-muted-foreground">
                        era {maybe(previous.bestFit)}
                        {previous.tier ? ` · ${previous.tier}` : ""} → agora{" "}
                        {maybe(score.bestFit)}
                        {score.tier ? ` · ${score.tier}` : ""}
                      </p>
                    )}

                    {fits && (
                      <dl className="divide-y rounded-md border px-3">
                        {Object.entries(fits).map(([axis, v]) => (
                          <Field key={axis} label={axis}>
                            <span className="tabular font-medium">{maybe(v)}</span>
                          </Field>
                        ))}
                      </dl>
                    )}

                    {score.wrongType && (
                      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                          <TriangleAlert className="size-3.5" />
                          Descartada por ramo errado
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Não é encaixe fraco — é outro negócio. O CNAE é um filtro grosso.
                        </p>
                      </div>
                    )}

                    {score.hook && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Gancho</p>
                        <p className="rounded-md border bg-muted/30 p-2 text-sm">
                          {score.hook}
                        </p>
                      </div>
                    )}

                    {score.advice && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Conselho</p>
                        <p className="text-sm text-muted-foreground">{score.advice}</p>
                      </div>
                    )}

                    {evidence?.justification && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Justificativa</p>
                        <p className="text-sm text-muted-foreground">
                          {evidence.justification}
                        </p>
                      </div>
                    )}

                    {evidence?.evidence && evidence.evidence.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-medium">Evidências</p>
                        <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
                          {evidence.evidence.map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <Separator />
                    <p className="text-xs text-muted-foreground">
                      {score.model} · prompt{" "}
                      <span className="font-mono">{score.promptSha}</span> ·{" "}
                      {dateBr(score.scoredAt)}
                    </p>
                  </div>
                )}

                {/*
                  Outside the branches above on purpose: an impression is most
                  useful precisely where there is no score yet, or where the only
                  score says "sem site". It is also the one thing here that works
                  before the company has been marked as a lead.
                */}
                <Separator />
                <div className="grid gap-1.5">
                  <Label htmlFor="impression">Sua impressão</Label>
                  <Textarea
                    id="impression"
                    rows={4}
                    value={impression}
                    onChange={(e) => setImpression(e.target.value)}
                    placeholder="o que você viu olhando essa empresa…"
                  />
                  <p className="text-xs text-muted-foreground">
                    Entra como evidência na próxima pontuação, e pesa mais que os sinais
                    automáticos — você olhou, o robô leu uma página. A nota continua vindo da
                    rubrica: pedir “dá 5” não muda nada.
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" disabled={busy} onClick={() => void saveAndRescore()}>
                      {rescore.isPending ? "Pontuando…" : "Salvar e pontuar de novo"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!dirty || busy}
                      onClick={saveImpression}
                    >
                      Só salvar
                    </Button>
                  </div>
                  {stored && !dirty && !staleScore && score?.model && (
                    <p className="text-xs text-muted-foreground">
                      Esta nota já considerou sua impressão.
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="lead" className="space-y-4 pt-3">
                {!lead ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Não está marcada como lead.</p>
                    <Button
                      size="sm"
                      onClick={() => flag.mutate({ projectId, cnpjs: [c.cnpj] })}
                    >
                      Marcar como lead
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-1.5">
                      <Label>Estado</Label>
                      <Select
                        value={lead.status}
                        onValueChange={(v) =>
                          setStatus.mutate({
                            projectId,
                            cnpj: c.cnpj,
                            status: v as LeadStatus,
                          })
                        }
                      >
                        <SelectTrigger className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LEAD_STATUSES.map((st) => (
                            <SelectItem key={st} value={st}>
                              {LEAD_LABEL[st]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        O app registra o que você fez. Ele nunca manda mensagem.
                      </p>
                    </div>

                    <div className="grid gap-1.5">
                      <Label htmlFor="notes">Anotações</Label>
                      <Textarea
                        id="notes"
                        rows={5}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="o que aconteceu…"
                      />
                      <p className="text-xs text-muted-foreground">
                        Um registro do contato, só para você. O modelo nunca lê isso — para isso
                        existe “sua impressão”, na aba Pontuação.
                      </p>
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={notes === (lead.notes ?? "") || setNotesMut.isPending}
                          onClick={() => setNotesMut.mutate({ projectId, cnpj: c.cnpj, notes })}
                        >
                          Salvar anotação
                        </Button>
                      </div>
                    </div>

                    <dl className="divide-y border-t pt-2">
                      <Field label="Marcada em">{dateBr(lead.flaggedAt)}</Field>
                      <Field label="Contatada em">{dateBr(lead.contactedAt)}</Field>
                    </dl>
                  </>
                )}
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
