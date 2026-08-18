"use client";

import { Suspense, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { useProject, ErrorBox } from "@/components/bits";
import { CnaePanel } from "@/components/CnaePanel";
import type { ProjectSpec, Axis, Probe } from "@cnpj/core";

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function ProjectTab() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [projectId, setProject] = useProject();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", icpText: "" });

  const list = useQuery(trpc.project.list.queryOptions());
  const current = useQuery({
    ...trpc.project.get.queryOptions({ id: projectId ?? "" }),
    enabled: Boolean(projectId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.project.list.queryKey() });
    if (projectId)
      void qc.invalidateQueries({ queryKey: trpc.project.get.queryKey({ id: projectId }) });
  };

  const create = useMutation({
    ...trpc.project.create.mutationOptions(),
    onSuccess: (r) => {
      setCreating(false);
      invalidate();
      setProject(r.id);
    },
  });
  const update = useMutation({
    ...trpc.project.update.mutationOptions(),
    onSuccess: invalidate,
  });
  const compile = useMutation({
    ...trpc.project.compile.mutationOptions(),
    onSuccess: invalidate,
  });

  const project = current.data;
  const spec = project?.spec ?? null;

  return (
    <>
      <h1>Projetos</h1>
      <p className="lede">
        Descreva o que você vende e quem é o cliente ideal, em português corrido. O modelo
        transforma isso em filtros e numa rubrica de pontuação — e mostra quais critérios ele{" "}
        <b>não</b> conseguiu transformar em filtro.
      </p>

      <div className="panel">
        <div className="row">
          <select
            className="sel"
            style={{ maxWidth: 320 }}
            value={projectId ?? ""}
            onChange={(e) => e.target.value && setProject(e.target.value)}
          >
            <option value="">— escolha um projeto —</option>
            {(list.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancelar" : "Novo projeto"}
          </button>
        </div>
      </div>

      {creating && (
        <div className="panel">
          <ErrorBox error={create.error} />
          <label className="field">
            <span>Nome</span>
            <input
              className="inp"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Sites para escolas particulares"
            />
          </label>
          <label className="field">
            <span>O que você vende</span>
            <small>Concreto. O que o cliente recebe e o que muda para ele.</small>
            <textarea
              className="inp"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Site institucional com portal do aluno, entregue em duas semanas..."
            />
          </label>
          <label className="field">
            <span>Perfil de cliente ideal (ICP)</span>
            <small>Do jeito que você explicaria para alguém. Critério por critério.</small>
            <textarea
              className="inp"
              value={draft.icpText}
              onChange={(e) => setDraft({ ...draft, icpText: e.target.value })}
              placeholder="escolas particulares de ensino médio, não-MEI, com mais de 50 alunos..."
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={draft.name.trim().length < 2 || create.isPending}
            onClick={() => create.mutate({ ...draft, id: slugify(draft.name) })}
          >
            {create.isPending ? "Criando…" : "Criar projeto"}
          </button>
        </div>
      )}

      {project && (
        <>
          <div className="panel">
            <label className="field">
              <span>O que você vende</span>
              <textarea
                className="inp"
                defaultValue={project.description}
                onBlur={(e) => update.mutate({ id: project.id, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Perfil de cliente ideal (ICP)</span>
              <textarea
                className="inp"
                defaultValue={project.icpText}
                onBlur={(e) => update.mutate({ id: project.id, icpText: e.target.value })}
              />
            </label>
            <div className="row">
              <button
                className="btn btn-primary"
                disabled={compile.isPending || !project.description.trim()}
                onClick={() => compile.mutate({ id: project.id })}
              >
                {compile.isPending ? "Compilando…" : "Compilar perfil"}
                <small>gasta LLM · 2 chamadas</small>
              </button>
              {project.specCompiledAt && (
                <span className="muted">
                  compilado {new Date(project.specCompiledAt).toLocaleString("pt-BR")}
                  {project.specModel ? ` · ${project.specModel}` : ""}
                </span>
              )}
            </div>
            <ErrorBox error={compile.error} />
          </div>

          {spec && <SpecPanel spec={spec} />}
          <CnaePanel projectId={project.id} />
        </>
      )}
    </>
  );
}

/**
 * The ICP coverage panel.
 *
 * The `não deu` rows are the reason this exists. The Receita has no headcount,
 * no revenue and no tech stack, so a criterion asking for one cannot become a
 * filter — and without saying so, the list comes out broader than the profile
 * asked for and nothing on screen admits it.
 */
function SpecPanel({ spec }: { spec: ProjectSpec }) {
  return (
    <>
      <h2>Do seu perfil de cliente ideal</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>situação</th>
              <th>critério</th>
              <th>onde entrou</th>
            </tr>
          </thead>
          <tbody>
            {spec.icpCoverage.map((c, i) => (
              <tr key={i}>
                <td>
                  <span className={`chip ${c.mapped ? "chip-plain" : "chip-bad"}`}>
                    {c.mapped ? "filtro" : "não deu"}
                  </span>
                </td>
                <td className="wrap">{c.criterion}</td>
                <td className="wrap muted">{c.mappedTo}</td>
              </tr>
            ))}
            {spec.icpCoverage.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  nenhum critério registrado
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Rubrica</h2>
      <div className="panel">
        <p style={{ marginTop: 0 }}>
          <b>{spec.summary}</b>
        </p>
        <p className="muted" style={{ margin: "4px 0" }}>
          Quem decide: {spec.buyer} · Problema: {spec.problem}
        </p>
        {spec.rubric.axes.map((a: Axis) => (
          <details key={a.key} style={{ marginTop: 8 }}>
            <summary>
              <b>{a.label}</b> — {a.question}
            </summary>
            <ul style={{ margin: "6px 0", paddingLeft: 20 }}>
              {(["5", "4", "3", "2", "1"] as const).map((lvl) => (
                <li key={lvl}>
                  <code>{lvl}</code> {a.anchors[lvl]}
                </li>
              ))}
            </ul>
          </details>
        ))}
        {spec.probes.length > 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Sinais procurados na página: {spec.probes.map((p: Probe) => p.label).join(", ")}
          </p>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<p className="muted">carregando…</p>}>
      <ProjectTab />
    </Suspense>
  );
}
