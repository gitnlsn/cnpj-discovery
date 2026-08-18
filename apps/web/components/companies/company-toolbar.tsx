"use client";

import { Download, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { LEAD_LABEL, LEAD_STATUSES } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { CnaeCombobox } from "./cnae-combobox";

export interface Filters {
  q: string;
  cnae: string;
  uf: string;
  flag: string;
  crawled: string;
  /** "" = processadas (padrão) · "nao" = as que faltam · "todas" = tudo */
  situacao: "" | "nao" | "todas";
  order: "score" | "founded" | "name";
}

export const EMPTY_FILTERS: Filters = {
  q: "",
  cnae: "",
  uf: "",
  flag: "",
  crawled: "",
  situacao: "",
  order: "score",
};

/**
 * How many of the *popover's* filters are narrowing the list.
 *
 * CNAE is deliberately excluded: it has its own visible control, so counting it
 * here would show a badge for a filter the button does not contain.
 */
function activeCount(f: Filters): number {
  return [f.uf, f.flag, f.crawled, f.situacao].filter(Boolean).length;
}

/**
 * Search, filters, and the two things you do to the whole list.
 *
 * The filters collapse into a popover instead of sitting as seven loose
 * controls across the page — that row was as tall as three rows of data and
 * pushed the table below the fold.
 */
export function CompanyToolbar({
  projectId,
  filters,
  onChange,
  onAdd,
  exportUrl,
  total,
  shown,
}: {
  projectId: string;
  filters: Filters;
  onChange: (f: Filters) => void;
  onAdd: () => void;
  exportUrl: string;
  total: number | null;
  shown: number;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    onChange({ ...filters, [k]: v });
  const active = activeCount(filters);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder="nome ou CNPJ"
          className="h-8 w-56 pl-8"
        />
        {filters.q && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
            onClick={() => set("q", "")}
            aria-label="Limpar busca"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="w-[19rem]">
        <CnaeCombobox
          projectId={projectId}
          value={filters.cnae}
          onChange={(v) => set("cnae", v)}
        />
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-8">
            <SlidersHorizontal className="size-3.5" />
            Filtros
            {active > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                {active}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3">
          <div className="grid gap-1">
            <Label htmlFor="f-uf" className="text-xs">
              UF
            </Label>
            <Input
              id="f-uf"
              value={filters.uf}
              maxLength={2}
              onChange={(e) => set("uf", e.target.value.toUpperCase())}
              placeholder="SP"
              className="h-8 w-20"
            />
          </div>

          <div className="grid gap-1">
            <Label className="text-xs">Marcação</Label>
            <Select
              value={filters.flag || "all"}
              onValueChange={(v) => set("flag", v === "all" ? "" : v)}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">todas</SelectItem>
                <SelectItem value="none">não marcadas</SelectItem>
                <SelectItem value="any">marcadas (qualquer)</SelectItem>
                {LEAD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label className="text-xs">Site</Label>
              <Select
                value={filters.crawled || "all"}
                onValueChange={(v) => set("crawled", v === "all" ? "" : v)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">todas</SelectItem>
                  <SelectItem value="sim">lido</SelectItem>
                  <SelectItem value="nao">não lido</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Situação</Label>
              <Select
                value={filters.situacao || "processadas"}
                onValueChange={(v) =>
                  set("situacao", v === "processadas" ? "" : (v as Filters["situacao"]))
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="processadas">processadas</SelectItem>
                  <SelectItem value="nao">faltando processar</SelectItem>
                  <SelectItem value="todas">todas</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {active > 0 && (
            <>
              <Separator />
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() =>
                  onChange({
                    ...EMPTY_FILTERS,
                    q: filters.q,
                    order: filters.order,
                    cnae: filters.cnae,
                  })
                }
              >
                Limpar filtros
              </Button>
            </>
          )}
        </PopoverContent>
      </Popover>

      <Select value={filters.order} onValueChange={(v) => set("order", v as Filters["order"])}>
        <SelectTrigger className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="score">maior nota</SelectItem>
          <SelectItem value="founded">mais novas</SelectItem>
          <SelectItem value="name">nome</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex-1" />

      <span className="text-xs text-muted-foreground tabular">
        {shown}
        {total != null && total !== shown ? ` de ${total}` : ""}
      </span>

      <Button variant="outline" size="sm" className="h-8" asChild>
        <a href={exportUrl} download>
          <Download className="size-3.5" />
          CSV
        </a>
      </Button>

      <Button size="sm" className="h-8" onClick={onAdd}>
        <Plus className="size-3.5" />
        Adicionar empresas
      </Button>
    </div>
  );
}
