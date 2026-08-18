"use client";

import { Download, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { LEAD_LABEL, LEAD_STATUSES } from "@/lib/format";
import { cn } from "@/lib/utils";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
 * CNAE is excluded: it has its own visible control, so counting it here would
 * put a badge on a button that does not contain it.
 */
function activeCount(f: Filters): number {
  return [f.uf, f.flag, f.crawled, f.situacao].filter(Boolean).length;
}

/** A labelled control. Every input in the toolbar says what it is. */
function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1", className)}>
      <Label
        htmlFor={htmlFor}
        className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * A row of options, all visible, one click each.
 *
 * These used to be `Select`s inside the filter popover — a dropdown opening
 * inside a popover escapes its boundary and renders over the edge. For two or
 * three choices a dropdown also hides the options and costs two clicks, so
 * showing them is both better looking and faster.
 */
function Choices({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      value={value || "__all__"}
      // Radix clears the value when the active item is re-clicked; keep the
      // current one rather than dropping into an unrepresentable empty state.
      onValueChange={(v) => onChange(v === "__all__" ? "" : v || value)}
      className="flex flex-wrap justify-start gap-1"
      variant="outline"
      size="sm"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value || "__all__"}
          value={o.value || "__all__"}
          className="h-7 rounded-md border px-2 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary/10"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
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

            <Field label="Marcação">
              <Choices
                value={filters.flag}
                onChange={(v) => set("flag", v)}
                options={[
                  { value: "", label: "todas" },
                  { value: "none", label: "não marcadas" },
                  { value: "any", label: "marcadas" },
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
