"use client";

import { Download, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { LEAD_LABEL, LEAD_STATUSES, type LeadFilter } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Field, Choices, MultiChoices } from "@/components/filter-controls";
import { CnaeCombobox } from "./cnae-combobox";

export interface Filters {
  q: string;
  cnae: string;
  uf: string;
  /** Lead states to keep. Empty = todas. "none" is "não marcadas". */
  flags: LeadFilter[];
  crawled: string;
  /** "" = processadas (padrão) · "nao" = as que faltam · "todas" = tudo */
  situacao: "" | "nao" | "todas";
  order: "score" | "founded" | "name";
}

export const EMPTY_FILTERS: Filters = {
  q: "",
  cnae: "",
  uf: "",
  flags: [],
  crawled: "",
  situacao: "",
  order: "score",
};

/**
 * How many of the *popover's* filters are narrowing the list.
 *
 * CNAE is excluded: it has its own visible control, so counting it here would
 * put a badge on a button that does not contain it.
 */
function activeCount(f: Filters): number {
  return [f.uf, f.flags.length ? "sim" : "", f.crawled, f.situacao].filter(Boolean).length;
}

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
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Buscar" htmlFor="f-q">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="f-q"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="nome ou CNPJ"
            className="h-8 w-56 pl-8"
          />
          {filters.q && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
              onClick={() => set("q", "")}
              aria-label="Limpar busca"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </Field>

      <Field label="CNAE" className="w-[19rem]">
        <CnaeCombobox
          projectId={projectId}
          value={filters.cnae}
          onChange={(v) => set("cnae", v)}
        />
      </Field>

      <Field label="Filtros">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <SlidersHorizontal className="size-3.5" />
              {active > 0 ? `${active} ativo${active > 1 ? "s" : ""}` : "nenhum"}
              {active > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                  {active}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 space-y-4">
            <Field label="Situação">
              <Choices
                value={filters.situacao}
                onChange={(v) => set("situacao", v as Filters["situacao"])}
                options={[
                  { value: "", label: "processadas" },
                  { value: "nao", label: "faltando" },
                  { value: "todas", label: "todas" },
                ]}
              />
            </Field>

            <Field label="Site">
              <Choices
                value={filters.crawled}
                onChange={(v) => set("crawled", v)}
                options={[
                  { value: "", label: "todas" },
                  { value: "sim", label: "lido" },
                  { value: "nao", label: "não lido" },
                ]}
              />
            </Field>

            <Field
              label="Marcação"
              hint="Escolha quantas quiser; nenhuma escolhida traz todas."
            >
              <MultiChoices
                value={filters.flags}
                onChange={(v) => set("flags", v as LeadFilter[])}
                options={[
                  { value: "none", label: "não marcadas" },
                  ...LEAD_STATUSES.map((st) => ({ value: st, label: LEAD_LABEL[st] })),
                ]}
              />
            </Field>

            <Field label="UF" htmlFor="f-uf">
              <Input
                id="f-uf"
                value={filters.uf}
                maxLength={2}
                onChange={(e) => set("uf", e.target.value.toUpperCase())}
                placeholder="todas"
                className="h-8 w-20"
              />
            </Field>

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
      </Field>

      <Field label="Ordenar por">
        <Select
          value={filters.order}
          onValueChange={(v) => set("order", v as Filters["order"])}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="score">maior nota</SelectItem>
            <SelectItem value="founded">mais novas</SelectItem>
            <SelectItem value="name">nome</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div className="flex-1" />

      <span className="tabular pb-2 text-xs text-muted-foreground">
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
