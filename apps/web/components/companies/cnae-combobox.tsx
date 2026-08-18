"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Pick a CNAE by what it means, not by remembering seven digits.
 *
 * The options are the codes actually present in this project's companies, with
 * their official descriptions and counts — so the list can only offer filters
 * that would return something, and the description is right there to catch the
 * case where the code is not the segment you thought it was.
 */
export function CnaeCombobox({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string;
  onChange: (cnae: string) => void;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const options = useQuery(trpc.companies.cnaeOptions.queryOptions({ projectId }));
  const list = options.data ?? [];
  const current = list.find((o) => o.cnae === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-full justify-between font-normal"
        >
          <span className="truncate">
            {current ? (
              <>
                <span className="font-mono text-xs">{current.cnae}</span>
                {current.descricao ? ` · ${current.descricao}` : ""}
              </>
            ) : (
              <span className="text-muted-foreground">todos os CNAEs</span>
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0">
        <Command>
          <CommandInput placeholder="código ou descrição…" className="h-9" />
          <CommandList>
            <CommandEmpty>
              {list.length === 0
                ? "Nenhuma empresa no projeto ainda."
                : "Nenhum CNAE encontrado."}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="todos"
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check className={cn("size-3.5", value ? "opacity-0" : "opacity-100")} />
                todos os CNAEs
              </CommandItem>
              {list.map((o) => (
                <CommandItem
                  key={o.cnae}
                  value={`${o.cnae} ${o.descricao ?? ""}`}
                  onSelect={() => {
                    onChange(o.cnae === value ? "" : o.cnae);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("size-3.5", o.cnae === value ? "opacity-100" : "opacity-0")}
                  />
                  <span className="font-mono text-xs">{o.cnae}</span>
                  <span className="truncate">{o.descricao ?? "—"}</span>
                  <span className="ml-auto tabular text-xs text-muted-foreground">
                    {o.count}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
