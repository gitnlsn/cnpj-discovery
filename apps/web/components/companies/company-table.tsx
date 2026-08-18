"use client";

import { Building2, TriangleAlert } from "lucide-react";
import type { CompanyRow } from "@/lib/api-types";
import { LEAD_LABEL, LEAD_VARIANT, TIER_CLASS, maybe, shortUrl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
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
import { CompanyRowActions } from "./company-row-actions";

/** Site signals worth surfacing in the row; the rest live in the detail sheet. */
function SiteBadges({ row }: { row: CompanyRow }) {
  const s = row.crawl?.signals;
  if (row.crawl?.error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive" className="max-w-[13rem] truncate">
            {row.crawl.error}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{row.crawl.error}</TooltipContent>
      </Tooltip>
    );
  }
  if (!row.crawl) {
    const guess = row.places?.websiteUrl ?? row.guessedSite;
    return guess ? (
      <span className="text-xs text-muted-foreground">palpite: {shortUrl(guess, 26)}</span>
    ) : (
      <span className="text-xs text-muted-foreground">sem site conhecido</span>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {row.crawl.finalUrl && (
        <a
          href={row.crawl.finalUrl}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
          className="truncate text-xs underline-offset-2 hover:underline"
        >
          {shortUrl(row.crawl.finalUrl, 28)}
        </a>
      )}
      <div className="flex flex-wrap gap-1">
        {s?.isLinkHub && (
          <Badge variant="secondary" className="text-[10px]">
            link na bio
          </Badge>
        )}
        {s?.isFreeBuilder && (
          <Badge variant="secondary" className="text-[10px]">
            site grátis
          </Badge>
        )}
        {s?.hasViewport === false && (
          <Badge variant="secondary" className="text-[10px]">
            não responsivo
          </Badge>
        )}
        {s?.platform && (
          <Badge variant="outline" className="text-[10px]">
            {s.platform}
          </Badge>
        )}
      </div>
    </div>
  );
}

export interface RowHandlers {
  onReveal: (cnpj: string) => void;
  onCrawl: (cnpj: string) => void;
  onScore: (cnpj: string) => void;
  onFlag: (cnpj: string) => void;
  onRemove: (cnpj: string) => void;
}

/**
 * The dense table. One entity, one screen.
 *
 * Two lines per row: the name, then the identifiers in mono underneath. Numbers
 * are tabular so a column can be scanned down. A missing score renders as an em
 * dash and never as zero.
 */
export function CompanyTable({
  rows,
  loading,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  handlers,
  emptyAction,
}: {
  rows: CompanyRow[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (cnpj: string) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (row: CompanyRow) => void;
  handlers: RowHandlers;
  emptyAction?: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 rounded-md border p-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={Building2}
          title="Nenhuma empresa"
          description="Ou o projeto ainda está vazio, ou os filtros não deixaram nada passar."
          action={emptyAction}
        />
      </div>
    );
  }

  const allChecked = rows.every((r) => selected.has(r.company.cnpj));

  return (
    <div className="rounded-md border">
      <Table
        className="table-dense"
        containerClassName="max-h-[calc(100svh-13rem)] overflow-auto rounded-md"
      >
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow>
            <TableHead className="w-9">
              <Checkbox
                checked={allChecked}
                aria-label="Selecionar todas"
                onCheckedChange={(v) => onToggleAll(v === true)}
              />
            </TableHead>
            <TableHead className="w-[17rem]">empresa</TableHead>
            <TableHead className="w-[12rem]">site</TableHead>
            <TableHead className="w-[9rem]">telefone</TableHead>
            <TableHead className="w-[5rem]">nota</TableHead>
            <TableHead className="w-[15rem]">gancho</TableHead>
            <TableHead className="w-24">marcação</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const { company: c, score, lead, contacts } = row;
            const phone = contacts[0];
            const isSelected = selected.has(c.cnpj);
            return (
              <TableRow
                key={c.cnpj}
                data-state={isSelected ? "selected" : undefined}
                onClick={() => onOpen(row)}
                className="cursor-pointer"
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    aria-label={`Selecionar ${c.nomeFantasia ?? c.cnpj}`}
                    onCheckedChange={() => onToggle(c.cnpj)}
                  />
                </TableCell>

                <TableCell className="max-w-[17rem]">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">
                      {c.nomeFantasia ?? c.razaoSocial ?? c.cnpj}
                    </span>
                    {c.mei && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        MEI
                      </Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {c.cnae} · {c.municipio ?? "?"}/{c.uf ?? "?"}
                    {c.dataInicioAtividade ? ` · ${c.dataInicioAtividade}` : ""}
                  </div>
                </TableCell>

                <TableCell className="max-w-[12rem]">
                  <SiteBadges row={row} />
                </TableCell>

                <TableCell>
                  {phone ? (
                    <div className="flex flex-col gap-0.5">
                      <a
                        href={phone.waMe ?? "#"}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {phone.phoneE164}
                      </a>
                      <span className="text-[10px] text-muted-foreground">
                        {phone.isMobile ? "celular" : "fixo"}
                        {phone.source === "site" ? " · do site" : ""}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell>
                  {score?.error ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="destructive" className="gap-1">
                          <TriangleAlert className="size-3" />
                          falhou
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">{score.error}</TooltipContent>
                    </Tooltip>
                  ) : score?.tier ? (
                    <div className="flex flex-col items-start gap-0.5">
                      <Badge className={cn("uppercase", TIER_CLASS[score.tier])}>
                        {score.tier}
                      </Badge>
                      <span className="tabular text-[11px] text-muted-foreground">
                        nota {maybe(score.bestFit)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {score?.wrongType && (
                    <Badge variant="destructive" className="mt-0.5 block w-fit text-[10px]">
                      ramo errado
                    </Badge>
                  )}
                </TableCell>

                <TableCell className="max-w-[15rem]">
                  {score?.hook ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="line-clamp-2 w-[14rem] cursor-help whitespace-normal text-xs">
                          {score.hook}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">{score.hook}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell>
                  {lead ? (
                    <Badge variant={LEAD_VARIANT[lead.status]}>{LEAD_LABEL[lead.status]}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>

                <TableCell>
                  <CompanyRowActions
                    row={row}
                    onReveal={() => handlers.onReveal(c.cnpj)}
                    onCrawl={() => handlers.onCrawl(c.cnpj)}
                    onScore={() => handlers.onScore(c.cnpj)}
                    onFlag={() => handlers.onFlag(c.cnpj)}
                    onRemove={() => handlers.onRemove(c.cnpj)}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
