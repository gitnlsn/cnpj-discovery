"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus, FolderOpen } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProjectFormDialog } from "@/components/project/project-form-dialog";

/**
 * The active project, in the header.
 *
 * It used to be a bare `<select>` buried inside the first panel of the projects
 * page, which made the one piece of state that scopes every other screen the
 * least visible thing on it.
 */
export function ProjectSwitcher() {
  const trpc = useTRPC();
  const [projectId, setProject] = useProject();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const list = useQuery(trpc.project.list.queryOptions());
  const projects = list.data ?? [];
  const current = projects.find((p) => p.id === projectId);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="h-8 w-56 justify-between font-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              <FolderOpen className="size-3.5 shrink-0 opacity-60" />
              <span className="truncate">
                {current?.name ?? (
                  <span className="text-muted-foreground">escolha um projeto</span>
                )}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar projeto…" className="h-9" />
            <CommandList>
              <CommandEmpty>Nenhum projeto.</CommandEmpty>
              <CommandGroup>
                {projects.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.name} ${p.id}`}
                    onSelect={() => {
                      setProject(p.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "size-3.5",
                        p.id === projectId ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{p.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setOpen(false);
                    setCreating(true);
                  }}
                >
                  <Plus className="size-3.5" />
                  Novo projeto
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
