"use client";

import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Globe, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import {
  errorMessage,
  maybe,
  nf,
  shortUrl,
  LEAD_LABEL,
  LEAD_STATUSES,
  LEAD_VARIANT,
  TIER_CLASS,
} from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SweepBar } from "@/components/openweb/sweep-bar";
import { Field, Choices } from "@/components/filter-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
 * The three verdicts, and the words they are allowed to be shown with.
 *
 * "unmatched" says *não achamos o CNPJ* and never "sem CNPJ", "informal" or
 * "não registrado". Those are conclusions nobody verified, and this is the label a
 * person reads before deciding what a whole column means.
 */
const VERDICTS = [
  {
    value: "unmatched",
    label: "sem CNPJ na Receita",
    hint: "Sites que não conseguimos ligar a nenhuma empresa da base — o motivo desta aba existir. Cuidado com a leitura: significa que NÓS não achamos o CNPJ, não que a empresa não tenha um. Para contatar, use o e-mail e o telefone que lemos na própria página.",
  },
  {
    value: "out_of_reach",
    label: "na base, fora do seu CNAE",
    hint: "Tem CNPJ e está na Receita, mas os filtros do seu projeto não devolvem esta empresa. Vale promover para a aba Empresas, onde todos os verbos já funcionam.",
  },
  {
    value: "in_reach",
    label: "já na base, dentro do CNAE",
    hint: "A sua própria consulta por CNAE já alcança esta empresa. É o denominador da varredura, não o resultado dela.",
  },
] as const;

function OpenWebPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  // Abre no que a aba existe para mostrar: site sem CNPJ correspondente. Antes
  // abria em "fora do alcance", que numa varredura orgânica é quase sempre um
  // punhado — dava a impressão de que a varredura não achou nada.
  const [verdict, setVerdict] = useState<string>("unmatched");
  const [budget, setBudget] = useState("5");
  const [engine, setEngine] = useState("places");
  const [pages, setPages] = useState("1");
  const [scope, setScope] = useState("projeto");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const enabled = Boolean(projectId);
  const status = useQuery({
    ...trpc.openWeb.status.queryOptions({ projectId: projectId! }),
    enabled,
  });
  const yields = useQuery({
    ...trpc.openWeb.yield.queryOptions({ projectId: projectId! }),
    enabled,
  });
  const plan = useQuery({
    ...trpc.openWeb.plan.queryOptions({
      projectId: projectId!,
      maxQueries: Number(budget),
      pagesPerQuery: Number(pages),
      nationwide: scope === "brasil",
    }),
    enabled,
  });
  // The lane allows one job at a time, so the buttons have to know. Polling here
  // (and in `SweepBar`) is also what runs `reconcileStaleJobs`, which frees a lane
  // still held by a row orphaned when the dev server restarted.
  const jobs = useQuery({
    ...trpc.jobs.status.queryOptions(),
    refetchInterval: (query) => (query.state.data?.openWeb ? 2000 : 6000),
    enabled,
  });
  const busy = Boolean(jobs.data?.openWeb);

  const leads = useQuery({
    ...trpc.openWeb.list.queryOptions({
      projectId: projectId!,
      verdict: verdict as "in_reach" | "out_of_reach" | "unmatched",
      q: q.trim() || undefined,
    }),
    enabled,
  });

  const refresh = () => void qc.invalidateQueries();
  const run = useMutation({
    ...trpc.openWeb.run.mutationOptions(),
    onSuccess: () => {
      toast.success("Varredura iniciada. Ela roda junto com a aba Empresas.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "não deu"),
  });
  const promote = useMutation({
    ...trpc.openWeb.promote.mutationOptions(),
    onSuccess: (r) => {
      toast.success(`Virou empresa do projeto: ${r.cnpj}`);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "não deu"),
  });
  const discard = useMutation({
    ...trpc.openWeb.discard.mutationOptions(),
    onSuccess: refresh,
  });
  const mark = useMutation({
    ...trpc.openWeb.setStatus.mutationOptions(),
    onSuccess: (r) => {
      toast.success(`${r.marked} marcado(s)`);
      setSelected(new Set());
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "não deu"),
  });
  const recrawl = useMutation({
    ...trpc.openWeb.recrawl.mutationOptions(),
    onSuccess: () => {
      toast.success("Relendo os sites para achar e-mail e telefone.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "não deu"),
  });
  const rescore = useMutation({
    ...trpc.openWeb.rescore.mutationOptions(),
    onSuccess: () => {
      toast.success("Pontuando os leads que ficaram sem nota.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e) ?? "não deu"),
  });

  if (!projectId) {
    return (
      <EmptyState
        icon={Globe}
        title="Escolha um projeto"
        description="A varredura usa o ICP e os CNAEs do projeto."
      />
    );
  }

  const s = status.data;
  const y = yields.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Internet aberta</h1>
          <p className="text-[13px] text-muted-foreground">
            Sites que a consulta por CNAE não alcança — e, principalmente, os que não batem com
            nenhum CNPJ da Receita.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-5">
          {/* Travessão e não zero para o que ninguém mediu ainda. */}
          <Stat label="sem CNPJ na Receita" value={y?.unmatched ?? null} />
          <Stat label="fora do seu CNAE" value={y?.out_of_reach ?? null} />
          <Stat label="já na base" value={y?.in_reach ?? null} />
          <Stat label="consultas gastas" value={y?.queriesSpent ?? null} />
        </div>
      </div>

      {s && !s.enabled && engine === "places" && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertDescription>
            Falta <code>GOOGLE_MAPS_API_KEY</code> no <code>.env</code>. A cota gratuita do
            Places cobre {nf(s.monthlyFree)} consultas por mês, e cada uma devolve até{" "}
            {s.perQuery} negócios com o site já incluído.
          </AlertDescription>
        </Alert>
      )}

      {!s?.specCompiled && s && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertDescription>
            Este projeto ainda não tem rubrica compilada. A varredura tira os termos de busca do
            ICP, então compile antes.
          </AlertDescription>
        </Alert>
      )}

      {/* O painel aparece com a spec compilada; a chave do Places só é exigida
          pelo buscador que a usa, então o DuckDuckGo funciona sem ela. */}
      {s?.specCompiled && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Field
              label="Buscador"
              hint={
                engine === "places"
                  ? "devolve nome, endereço E site de uma vez — o endereço é o que permite casar com o CNPJ na Receita"
                  : "busca orgânica: devolve páginas, sem endereço. Sobram o domínio do e-mail e os espelhos de cadastro para achar o CNPJ, então a maioria fica em “não achamos”"
              }
              className="min-w-[20rem]"
            >
              <Choices
                value={engine}
                onChange={setEngine}
                options={[
                  { value: "places", label: "Places" },
                  { value: "duckduckgo", label: "DuckDuckGo" },
                  { value: "google", label: "Google" },
                ]}
              />
            </Field>

            <Field
              label="Chamadas"
              hint={
                engine === "places"
                  ? `${nf(s.remaining)} de ${nf(s.monthlyFree)} sobrando este mês · até ${s.perQuery} negócios cada`
                  : "gasta do teto diário da busca na web, não da cota do Places"
              }
            >
              <Choices
                value={budget}
                onChange={setBudget}
                options={[
                  { value: "3", label: "3" },
                  { value: "5", label: "5" },
                  { value: "10", label: "10" },
                  { value: "20", label: "20" },
                ]}
              />
            </Field>

            {engine === "places" && (
              <Field
                label="Páginas por consulta"
                hint="20 resultados por chamada é o teto do Google; paginar é o único jeito de passar dele. Cada página é uma chamada cobrada, então isto divide o orçamento em vez de aumentá-lo."
                className="min-w-[18rem]"
              >
                <Choices
                  value={pages}
                  onChange={setPages}
                  options={[
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                    { value: "3", label: "3" },
                  ]}
                />
              </Field>
            )}

            <Field
              label="Onde"
              hint={
                scope === "brasil"
                  ? "sem recorte de cidade — o Google escolhe a geografia, e o teto por chamada é o mesmo"
                  : "as cidades vêm das empresas que este projeto já tem, então a varredura procura onde você já procura"
              }
              className="min-w-[20rem]"
            >
              <Choices
                value={scope}
                onChange={setScope}
                options={[
                  { value: "projeto", label: "cidades do projeto" },
                  { value: "brasil", label: "Brasil" },
                ]}
              />
            </Field>

            <Button
              onClick={() =>
                run.mutate({
                  projectId,
                  engine: engine as "places" | "google" | "duckduckgo",
                  maxQueries: Number(budget),
                  pagesPerQuery: Number(pages),
                  nationwide: scope === "brasil",
                  depth: 1,
                  crawl: true,
                  score: true,
                })
              }
              disabled={busy || run.isPending || (engine === "places" && s.remaining <= 0)}
            >
              {busy ? "Varredura em andamento" : "Varrer a internet aberta"}
            </Button>
          </div>

          {/* O plano antes do gasto: a cota é mensal, então uma varredura
              desperdiçada não volta até o mês virar. */}
          {plan.data && plan.data.queries.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                o que vai ser consultado
              </p>
              <ul className="flex flex-col gap-0.5 font-mono text-[12px]">
                {plan.data.queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.data && plan.data.queries.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              Nada para consultar: escolha CNAEs na aba Projetos, ou compile um ICP com termos
              positivos.
            </p>
          )}
        </Card>
      )}

      <SweepBar />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="site, título ou CNPJ"
          className="h-8 w-64"
        />
        <div className="flex-1" />
        {/* Grátis em termos de buscador: relê só sites já guardados. Existe porque
            um crawl vale o que o código que o rodou valia — leads achados antes da
            extração de contato têm emails/phones vazios. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            recrawl.mutate({ projectId, onlyWithoutContact: false, depth: 3, maxPages: 15 })
          }
          disabled={busy || recrawl.isPending}
        >
          Buscar contatos
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => rescore.mutate({ projectId, onlyFailed: true })}
          disabled={busy || rescore.isPending}
        >
          Pontuar os sem nota
        </Button>
        {/* Um link, não uma mutation: o navegador precisa poder seguir e baixar. */}
        <Button variant="outline" size="sm" asChild>
          <a
            href={`/api/export-openweb/${encodeURIComponent(projectId)}?verdict=${verdict}`}
            download
          >
            <Download className="size-3.5" /> CSV
          </a>
        </Button>
      </div>

      <Tabs value={verdict} onValueChange={setVerdict}>
        <TabsList>
          {VERDICTS.map((v) => (
            <Tooltip key={v.value}>
              <TooltipTrigger asChild>
                <TabsTrigger value={v.value}>
                  {v.label}
                  {y ? (
                    <span className="ml-1.5 tabular text-muted-foreground">
                      {nf(y[v.value as keyof typeof y] as number)}
                    </span>
                  ) : null}
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">{v.hint}</TooltipContent>
            </Tooltip>
          ))}
        </TabsList>
      </Tabs>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-[13px] font-medium">{selected.size} selecionado(s)</span>
          <div className="flex-1" />
          {LEAD_STATUSES.map((st) => (
            <Button
              key={st}
              size="sm"
              variant="outline"
              onClick={() => mark.mutate({ projectId, apexes: [...selected], status: st })}
              disabled={mark.isPending}
            >
              {LEAD_LABEL[st]}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => mark.mutate({ projectId, apexes: [...selected], status: null })}
            disabled={mark.isPending}
          >
            limpar marca
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            cancelar
          </Button>
        </div>
      )}

      {leads.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !leads.data?.length ? (
        <EmptyState
          icon={Globe}
          title="Nada aqui ainda"
          description={
            verdict === "unmatched"
              ? "Nenhum site sem CNPJ correspondente até agora. Isso é sobre o que a varredura achou, não sobre o que existe."
              : "Rode uma varredura para preencher esta aba."
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          {/* `table-fixed` com larguras explícitas: sem isso uma célula de texto
              longo empurra as vizinhas e o gancho passa por baixo da coluna de
              contato, que é exatamente o que acontecia. */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={leads.data?.length ? selected.size === leads.data.length : false}
                    onCheckedChange={(on) =>
                      setSelected(
                        on ? new Set((leads.data ?? []).map((l) => l.apex)) : new Set()
                      )
                    }
                    aria-label="selecionar todos"
                  />
                </TableHead>
                <TableHead className="w-[20rem]">site</TableHead>
                <TableHead className="w-24">nota</TableHead>
                <TableHead className="w-28">marca</TableHead>
                <TableHead className="w-[26rem]">gancho</TableHead>
                <TableHead className="w-56">contato</TableHead>
                <TableHead className="w-40">CNPJ casado</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.data.map((lead) => (
                <TableRow
                  key={lead.apex}
                  data-state={selected.has(lead.apex) ? "selected" : undefined}
                >
                  <TableCell className="align-top">
                    <Checkbox
                      checked={selected.has(lead.apex)}
                      onCheckedChange={(on) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(lead.apex);
                          else next.delete(lead.apex);
                          return next;
                        })
                      }
                      aria-label={`selecionar ${lead.apex}`}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="font-medium break-words">
                      {/* O nome vem do NOSSO crawl, nunca do Google — ver a nota
                          em `webLeads` sobre não haver coluna de nome. */}
                      {lead.title ?? lead.apex}
                    </div>
                    <a
                      href={lead.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate font-mono text-[11px] text-muted-foreground hover:underline"
                    >
                      {shortUrl(lead.finalUrl ?? lead.websiteUrl)}
                    </a>
                    {lead.crawlError && (
                      <div className="text-[11px] text-muted-foreground">{lead.crawlError}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.score?.tier ? (
                      <div className="flex flex-col gap-1">
                        <Badge className={TIER_CLASS[lead.score.tier] ?? ""}>
                          {lead.score.tier.toUpperCase()}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">
                          nota {maybe(lead.score.bestFit)}
                        </span>
                      </div>
                    ) : lead.score?.error ? (
                      <span className="text-[11px] text-muted-foreground">falhou</span>
                    ) : (
                      // Não pontuado e "pontuado com falha" são fatos diferentes.
                      <span className="text-muted-foreground">—</span>
                    )}
                    {lead.score?.wrongType && (
                      <Badge variant="outline" className="mt-1 text-[10px]">
                        ramo errado
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {lead.status ? (
                      <Badge variant={LEAD_VARIANT[lead.status]} className="text-[10px]">
                        {LEAD_LABEL[lead.status]}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-[13px]">
                    {lead.score?.hook ? (
                      // Quebra e limita: o gancho é uma frase inteira, e sem isto
                      // ele atravessava as colunas seguintes.
                      <span className="line-clamp-3 break-words">{lead.score.hook}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-[11px]">
                    {/* Para um lead sem CNPJ isto é a entrega: não há linha em
                        `contacts` (aquela tabela é chaveada por CNPJ) nem
                        telefone da Receita. */}
                    {lead.emails?.length || lead.phones?.length ? (
                      <div className="flex flex-col gap-0.5">
                        {(lead.emails ?? []).slice(0, 2).map((e) => (
                          <a
                            key={e}
                            href={`mailto:${e}`}
                            className="truncate font-mono hover:underline"
                          >
                            {e}
                          </a>
                        ))}
                        {(lead.phones ?? []).slice(0, 2).map((t) => (
                          <span key={t} className="font-mono text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : lead.crawledAt ? (
                      // Lemos e não achamos — e DIZ por quê. Uma célula vazia sem
                      // motivo é indistinguível de um crawler quebrado, que foi
                      // exatamente a dúvida que levou a esta coluna.
                      <span className="text-muted-foreground">{noContactReason(lead)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top font-mono text-[11px] break-all">
                    {lead.matchedCnpj ? (
                      <>
                        {lead.matchedCnpj}
                        {lead.matchedCnae && (
                          <div className="text-muted-foreground">{lead.matchedCnae}</div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">não achamos</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {lead.matchedCnpj && !lead.promotedAt && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => promote.mutate({ projectId, apex: lead.apex })}
                          disabled={promote.isPending}
                        >
                          virar empresa
                        </Button>
                      )}
                      {lead.promotedAt && (
                        <Badge variant="outline" className="text-[10px]">
                          no projeto
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => discard.mutate({ projectId, apex: lead.apex })}
                      >
                        descartar
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/**
 * Why a crawled lead has no contact.
 *
 * Each of these was observed on a real run, and none of them is the same fact:
 * a site that refused us, one that timed out, one whose page needs JavaScript,
 * and one we read in full that simply lists no address. Showing a blank cell for
 * all four is what made the crawler look broken when it was not.
 */
function noContactReason(lead: {
  httpStatus: number | null;
  crawlError: string | null;
  signals: unknown;
}): string {
  if (lead.crawlError) return lead.crawlError;
  if (lead.httpStatus === 403) return "o site recusou a leitura (403)";
  if (lead.httpStatus && lead.httpStatus >= 400) return `site respondeu ${lead.httpStatus}`;
  const signals = lead.signals as { isJsShell?: boolean | null } | null;
  if (signals?.isJsShell) return "página só abre com JavaScript";
  return "nada de contato nas páginas lidas";
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular leading-none">{maybe(value)}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

export default function Page() {
  // `useProject` reads `?project=`, so this needs the same Suspense boundary the
  // other pages have.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <OpenWebPage />
    </Suspense>
  );
}
