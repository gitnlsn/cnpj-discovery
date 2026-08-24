"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Infinity as InfinityIcon, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { errorMessage, nf } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
import { Field, Choices } from "@/components/filter-controls";
import { Input } from "@/components/ui/input";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 * How many internal pages to read beyond the homepage when adding.
 *
 * The deepest the crawler goes. It only follows links that look like contato,
 * sobre, serviços, produtos, planos or preços — so this is five useful pages,
 * not five random ones, and the per-host delay still applies.
 */
const DEEP_CRAWL = 5;

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
  // Defaults chosen from what the base actually looks like: in CNAE 8599, MEIs
  // are 71% of the rows and almost none has a website, so a run that includes
  // them comes back nearly all `cannot_determine`.
  const [mei, setMei] = useState("nao");
  // Was "com" — a hard requirement of an own-domain e-mail, because that guess
  // was the only route to a page to read. It is no longer: the continuous run
  // searches the web for a company with no readable site, so requiring the
  // e-mail now selects on registration hygiene rather than on fit. Still
  // offered, because with SERP switched off the old reasoning holds.
  const [site, setSite] = useState("");
  const [porte, setPorte] = useState("");
  const [matrizOnly, setMatrizOnly] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  // Off by default, and the default is the whole point: it changes what the
  // count means and what the query costs. See `includeCnaeSecundaria`.
  const [cnaeMode, setCnaeMode] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Whether anything will look for a company that has no site to guess.
  const serp = useQuery(trpc.enrichment.serpStatus.queryOptions());

  const picks = useQuery({
    ...trpc.discovery.picks.queryOptions({ projectId }),
    enabled: open,
  });
  const chosen = (picks.data ?? [])
    .filter((p) => p.chosen && p.status === "ok")
    .map((p) => p.cnae);

  const filters = {
    cnae: chosen.length ? chosen : undefined,
    includeCnaeSecundaria: cnaeMode === "any" || undefined,
    uf: uf.length === 2 ? [uf.toUpperCase()] : undefined,
    hasPhone: hasPhone || undefined,
    foundedFrom: /^\d{4}-\d{2}-\d{2}$/.test(foundedFrom) ? foundedFrom : undefined,
    mei: mei === "" ? undefined : mei === "sim",
    ownDomainEmail: site === "com" || undefined,
    porte: porte ? [porte] : undefined,
    matrizOnly: matrizOnly || undefined,
    isMobile: isMobile || undefined,
  };

  const results = useQuery({
    ...trpc.discovery.companies.queryOptions({
      filters,
      excludeProjectId: projectId,
      order,
      limit: 100,
      offset: 0,
    }),
    enabled: open && chosen.length > 0,
  });
  const reach = useQuery({
    ...trpc.discovery.reach.queryOptions({ filters, excludeProjectId: projectId }),
    enabled: open && chosen.length > 0,
  });

  const continuous = useMutation({
    ...trpc.companies.processContinuous.mutationOptions(),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success("Processamento contínuo iniciado. Pare pela aba Empresas.");
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
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
        runPipeline.mutate({ projectId, cnpjs: vars.cnpjs, depth: DEEP_CRAWL });
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
        className="flex max-h-[92svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        style={{ width: "min(72rem, 94vw)" }}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-4 pr-12">
          <DialogTitle>Adicionar empresas da base</DialogTitle>
          <DialogDescription>
            {reach.data ? (
              <>
                <b className="tabular">{nf(reach.data.total)}</b> empresas nos CNAEs escolhidos
                {reach.data.secundaria > 0 && (
                  // Mostrado como soma, não somado: quem faz disso o negócio e
                  // quem lista como atividade secundária são prospectos
                  // diferentes, e o número que decide a mira é a divisão.
                  <>
                    {" "}
                    (<span className="tabular">{nf(reach.data.principal)}</span> principal +{" "}
                    <span className="tabular">{nf(reach.data.secundaria)}</span> secundária)
                  </>
                )}{" "}
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
            <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 border-b px-6 py-3 md:grid-cols-4">
              <Field label="Ordem">
                <Select value={order} onValueChange={(v) => setOrder(v as Order)}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="founded-desc">mais novas primeiro</SelectItem>
                    <SelectItem value="founded-asc">mais antigas primeiro</SelectItem>
                    <SelectItem value="name">nome</SelectItem>
                    <SelectItem value="capital-desc">maior capital</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field label="UF" htmlFor="a-uf">
                <Input
                  id="a-uf"
                  value={uf}
                  maxLength={2}
                  placeholder="todas"
                  onChange={(e) => setUf(e.target.value.toUpperCase())}
                  className="h-8"
                />
              </Field>

              <Field label="Abertas a partir de" htmlFor="a-from">
                <Input
                  id="a-from"
                  value={foundedFrom}
                  placeholder="2025-01-01"
                  onChange={(e) => setFoundedFrom(e.target.value)}
                  className="h-8 font-mono"
                />
              </Field>

              <Field label="Porte">
                <Choices
                  value={porte}
                  onChange={setPorte}
                  options={[
                    { value: "", label: "todos" },
                    { value: "01", label: "n/i" },
                    { value: "03", label: "micro" },
                    { value: "05", label: "demais" },
                  ]}
                />
              </Field>

              <Field
                label="MEI"
                hint={mei === "nao" ? "MEI quase nunca tem site" : undefined}
                className="col-span-2"
              >
                <Choices
                  value={mei}
                  onChange={setMei}
                  options={[
                    { value: "", label: "todas" },
                    { value: "nao", label: "sem MEI" },
                    { value: "sim", label: "só MEI" },
                  ]}
                />
              </Field>

              <Field
                label="Site"
                hint={
                  site === "com"
                    ? "o site sai do domínio do e-mail — é o que dá o que visitar"
                    : serp.data?.enabled
                      ? "sem e-mail de domínio próprio, a busca na web procura a empresa"
                      : "sem site não há o que ler, e a empresa fica sem nota"
                }
                className="col-span-2"
              >
                <Choices
                  value={site}
                  onChange={setSite}
                  options={[
                    { value: "com", label: "com site" },
                    { value: "", label: "todas" },
                  ]}
                />
              </Field>

              <Field
                label="Atividade"
                hint={
                  cnaeMode === "any"
                    ? "inclui quem registrou o CNAE como atividade secundária — alcança bem mais empresas, e a consulta fica em ~1 s"
                    : "só quem registrou o CNAE como atividade principal"
                }
                className="col-span-2"
              >
                <Choices
                  value={cnaeMode}
                  onChange={setCnaeMode}
                  options={[
                    { value: "", label: "só principal" },
                    { value: "any", label: "principal + secundária" },
                  ]}
                />
              </Field>

              <Field label="Contato" className="col-span-2 md:col-span-3">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={hasPhone}
                      onCheckedChange={(v) => setHasPhone(v === true)}
                    />
                    com telefone
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={isMobile}
                      onCheckedChange={(v) => setIsMobile(v === true)}
                    />
                    só celular
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={matrizOnly}
                      onCheckedChange={(v) => setMatrizOnly(v === true)}
                    />
                    só matriz
                  </label>
                </div>
              </Field>

              <div className="flex items-end justify-end">
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
            </div>

            {site !== "com" && !serp.data?.enabled && (
              <Alert className="mx-6 mb-3 w-auto">
                <TriangleAlert className="size-4" />
                <AlertDescription>
                  A busca na web está desligada, então para estas empresas não há nada para ler
                  — elas entram no projeto e ficam sem nota. Ligue o SERP no <code>.env</code>,
                  ou use o Places depois para procurar um site (cota paga).
                </AlertDescription>
              </Alert>
            )}

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
              <Table className="table-dense" containerClassName="min-h-0 flex-1 overflow-auto">
                <TableHeader className="sticky top-0 z-10 bg-muted">
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
                      <TableCell className="font-mono text-xs">
                        {c.cnae}
                        {c.cnaeMatch === "secundaria" && (
                          // O selo é necessário porque a célula mostra o CNAE
                          // PRINCIPAL da empresa, que não é o que a trouxe até
                          // aqui. Sem ele a linha parece fora do filtro.
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant="outline"
                                className="ml-1 cursor-default px-1 py-0 text-[10px] font-normal"
                              >
                                2ª
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              alcançada pela atividade secundária{" "}
                              {c.cnaeSecundariaMatch.join(", ")}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
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

            {/*
              A plain div, not DialogFooter. That component ships `-mx-4 -mb-4`
              sized for the default `p-4` on DialogContent — with `p-0` here the
              negative margins dragged it out of the container and it rendered
              on top of the last rows. It also fights `px-6` with its own `p-4`.
              It was only contributing a border and a flex row.
            */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-b-xl border-t bg-muted/50 px-6 py-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Ao adicionar, o site de cada uma é lido a fundo (home + até {DEEP_CRAWL} páginas
                internas) e a empresa é pontuada — é o que faz a linha aparecer na lista.
                <span className="ml-1">
                  grátis + gasta LLM · ~{Math.ceil(picked.size / 10)} req
                </span>
              </p>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  disabled={continuous.isPending || rows.length === 0}
                  onClick={() =>
                    continuous.mutate({
                      projectId,
                      filters,
                      order,
                      depth: DEEP_CRAWL,
                      sourcePeriod: "2026-08",
                    })
                  }
                  title="Puxa uma empresa por vez com estes filtros, sem parar, até você mandar parar"
                >
                  <InfinityIcon className="size-3.5" />
                  Processamento contínuo
                </Button>
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
