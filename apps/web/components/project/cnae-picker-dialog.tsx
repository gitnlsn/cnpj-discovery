"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Waits for typing to settle before asking the server. */
function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Search the official CNAE dictionary and pick one.
 *
 * Typing seven digits from memory was never a real workflow — and the whole
 * hazard this project guards against is a code that does not mean what someone
 * assumed. Searching the official table by description means the description is
 * on screen at the moment of choosing, which is the only moment it can prevent
 * the mistake.
 *
 * Filtering happens in DuckDB, not in `cmdk`, so `shouldFilter` is off:
 * otherwise the client would filter the server's results a second time and hide
 * rows that matched without an accent.
 */
export function CnaePickerDialog({
  open,
  onOpenChange,
  onPick,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (cnae: string) => void;
  pending?: boolean;
}) {
  const trpc = useTRPC();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q);

  useEffect(() => {
    if (open) setQ("");
  }, [open]);

  const results = useQuery({
    ...trpc.discovery.searchCnaes.queryOptions({ q: debounced, limit: 30 }),
    enabled: open && debounced.trim().length > 0,
  });

  const rows = results.data ?? [];
  const typed = debounced.trim();
  // A pure-digit query is also a valid prefix, even when it matches no leaf
  // code: "85" is a real CNAE division. Offer it rather than dead-ending.
  const digits = /^\d{2,7}$/.test(typed) ? typed : null;
  const offerRaw = digits && !rows.some((r) => r.codigo === digits);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Adicionar CNAE</DialogTitle>
          <DialogDescription>
            Busque pelo código ou pela descrição. Acento é opcional — “educacao” acha
            “Educação”.
          </DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} className="mt-3">
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="ex.: 8520, ensino medio, oficina…"
            autoFocus
          />
          <CommandList className="max-h-80">
            {typed.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Search className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Digite para buscar na tabela oficial de CNAEs.
                </p>
              </div>
            ) : results.isLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">buscando…</div>
            ) : (
              <>
                {rows.length === 0 && !offerRaw && (
                  <CommandEmpty>Nenhum CNAE com “{typed}”.</CommandEmpty>
                )}

                {offerRaw && (
                  <CommandGroup heading="Prefixo">
                    <CommandItem
                      value={`prefixo-${digits}`}
                      disabled={pending}
                      onSelect={() => onPick(digits!)}
                    >
                      <span className="font-mono text-xs">{digits}</span>
                      <span className="text-muted-foreground">
                        usar como prefixo — pega todas as subclasses abaixo
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}

                {rows.length > 0 && (
                  <CommandGroup heading="Tabela oficial">
                    {rows.map((c) => (
                      <CommandItem
                        key={c.codigo}
                        value={c.codigo}
                        disabled={pending}
                        onSelect={() => onPick(c.codigo)}
                      >
                        <span className="font-mono text-xs">{c.codigo}</span>
                        <span className="truncate">{c.descricao}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
