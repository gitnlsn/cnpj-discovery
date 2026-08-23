"use client";

import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Pencil, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { useProject } from "@/lib/use-project";
import { dateBr, errorMessage } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { ProjectFormDialog } from "@/components/project/project-form-dialog";
import { IcpCoverageCard } from "@/components/project/icp-coverage-card";
import { RubricCard } from "@/components/project/rubric-card";
import { CnaeTable } from "@/components/project/cnae-table";

function ProjectPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId] = useProject();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);

  const project = useQuery({
    ...trpc.project.get.queryOptions({ id: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const compile = useMutation({
    ...trpc.project.compile.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(
        r.resumed ? "Perfil compilado (retomado do alvo salvo)." : "Perfil compilado."
      );
    },
    onError: (e) => toast.error(errorMessage(e) ?? "Falhou."),
  });

  if (!projectId) {
    return (
      <>
        <Card>
          <EmptyState
            icon={FolderKanban}
            title="Nenhum projeto escolhido"
            description="Um projeto guarda o que você vende, o perfil de cliente ideal e os CNAEs alvo. Tudo o mais é escopado por ele."
            action={<Button onClick={() => setCreating(true)}>Criar projeto</Button>}
          />
        </Card>
        <ProjectFormDialog open={creating} onOpenChange={setCreating} />
      </>
    );
  }

  if (project.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const p = project.data;
  if (!p) return null;
  const spec = p.spec;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h1 className="text-lg font-semibold tracking-tight">{p.name}</h1>
          <p className="line-clamp-2 max-w-2xl text-sm text-muted-foreground">
            {p.description || "Sem descrição — edite o projeto para começar."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            Editar
          </Button>
          <Button
            size="sm"
            disabled={compile.isPending || !p.description.trim()}
            onClick={() => compile.mutate({ id: p.id })}
          >
            <Sparkles className="size-3.5" />
            {compile.isPending
              ? "Compilando…"
              : p.resumable
                ? "Terminar de compilar"
                : "Compilar perfil"}
            <span className="text-xs opacity-70">
              gasta LLM · {p.resumable ? "1 chamada (alvo já pronto)" : "2 chamadas"}
            </span>
          </Button>
        </div>
      </div>

      {p.specCompiledAt && (
        <p className="text-xs text-muted-foreground">
          Compilado em {dateBr(p.specCompiledAt)}
          {p.specModel ? ` · ${p.specModel}` : ""}
        </p>
      )}

      <Tabs defaultValue={spec ? "perfil" : "cnaes"}>
        <TabsList>
          <TabsTrigger value="perfil">Perfil</TabsTrigger>
          <TabsTrigger value="rubrica">Rubrica</TabsTrigger>
          <TabsTrigger value="cnaes">CNAEs</TabsTrigger>
        </TabsList>

        <TabsContent value="perfil" className="mt-3">
          {spec ? (
            <IcpCoverageCard spec={spec} />
          ) : (
            <NotCompiled onCompile={() => compile.mutate({ id: p.id })} />
          )}
        </TabsContent>

        <TabsContent value="rubrica" className="mt-3">
          {spec ? (
            <RubricCard spec={spec} />
          ) : (
            <NotCompiled onCompile={() => compile.mutate({ id: p.id })} />
          )}
        </TabsContent>

        <TabsContent value="cnaes" className="mt-3">
          <CnaeTable projectId={p.id} />
        </TabsContent>
      </Tabs>

      {compile.error && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(compile.error)}</AlertDescription>
        </Alert>
      )}

      <ProjectFormDialog
        open={editing}
        onOpenChange={setEditing}
        initial={{
          id: p.id,
          name: p.name,
          description: p.description,
          icpText: p.icpText,
        }}
      />
    </div>
  );
}

function NotCompiled({ onCompile }: { onCompile: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={Sparkles}
        title="Perfil ainda não compilado"
        description="Compilar transforma o texto do ICP em filtros e numa rubrica — e diz quais critérios a base da Receita não consegue atender."
        action={
          <Button size="sm" onClick={onCompile}>
            Compilar perfil
          </Button>
        }
      />
    </Card>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <ProjectPage />
    </Suspense>
  );
}
