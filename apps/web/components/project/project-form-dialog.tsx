"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import { errorMessage } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Accent-stripped, lowercase, hyphenated — the project id is also its URL. */
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export interface ProjectDraft {
  id?: string;
  name: string;
  description: string;
  icpText: string;
}

/**
 * Create or edit a project.
 *
 * One dialog for both, because the fields are identical and a separate "edit"
 * surface would drift from the "create" one the first time a field is added.
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ProjectDraft;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [, setProject] = useProject();
  const editing = Boolean(initial?.id);

  const [draft, setDraft] = useState<ProjectDraft>({
    name: "",
    description: "",
    icpText: "",
  });

  // Re-seed whenever the dialog opens so it never shows a stale draft.
  useEffect(() => {
    if (open) {
      setDraft(initial ?? { name: "", description: "", icpText: "" });
    }
  }, [open, initial]);

  const done = (message: string) => {
    void qc.invalidateQueries();
    toast.success(message);
    onOpenChange(false);
  };

  const create = useMutation({
    ...trpc.project.create.mutationOptions(),
    onSuccess: (r) => {
      setProject(r.id);
      done("Projeto criado.");
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });
  const update = useMutation({
    ...trpc.project.update.mutationOptions(),
    onSuccess: () => done("Projeto salvo."),
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  const pending = create.isPending || update.isPending;
  const valid = draft.name.trim().length >= 2;

  const submit = () => {
    if (editing && initial?.id) {
      update.mutate({ id: initial.id, ...draft });
    } else {
      create.mutate({ ...draft, id: slugify(draft.name) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar projeto" : "Novo projeto"}</DialogTitle>
          <DialogDescription>
            Descreva o que você vende e quem é o cliente ideal, em português corrido. O modelo
            transforma isso em filtros e numa rubrica.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Nome</Label>
            <Input
              id="name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Sites para escolas particulares"
            />
            {!editing && draft.name && (
              <p className="text-xs text-muted-foreground">
                id: <span className="font-mono">{slugify(draft.name) || "—"}</span>
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="description">O que você vende</Label>
            <Textarea
              id="description"
              rows={4}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Site institucional com portal do aluno, entregue em duas semanas…"
            />
            <p className="text-xs text-muted-foreground">
              Concreto: o que o cliente recebe e o que muda para ele.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="icp">Perfil de cliente ideal</Label>
            <Textarea
              id="icp"
              rows={4}
              value={draft.icpText}
              onChange={(e) => setDraft({ ...draft, icpText: e.target.value })}
              placeholder="escolas particulares de ensino médio em SP, não-MEI, com mais de 50 funcionários…"
            />
            <p className="text-xs text-muted-foreground">
              Critério por critério. Os que a base não suportar aparecem como “não deu”, em vez
              de sumirem calados.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!valid || pending}>
            {pending ? "Salvando…" : editing ? "Salvar" : "Criar projeto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
