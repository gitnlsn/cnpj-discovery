"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { ErrorBox, Num } from "@/components/bits";

/**
 * The CNAEs a project targets.
 *
 * Three outcomes, kept apart on purpose. "código inventado" means the model
 * made it up — folding that into "sem empresas" would hide the hallucination
 * behind a plausible zero, which is how a made-up segment survives review.
 */
const STATUS_LABEL: Record<string, { chip: string; text: string }> = {
  ok: { chip: "chip-plain", text: "existe" },
  empty: { chip: "chip-warm", text: "sem empresas" },
  unknown: { chip: "chip-bad", text: "código inventado" },
};

export function CnaePanel({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [manual, setManual] = useState("");

  const picks = useQuery(trpc.discovery.picks.queryOptions({ projectId }));
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: trpc.discovery.picks.queryKey({ projectId }) });

  const suggest = useMutation({
    ...trpc.discovery.suggest.mutationOptions(),
    onSuccess: () => void invalidate(),
  });
  const setChosen = useMutation({
    ...trpc.discovery.setChosen.mutationOptions(),
    onSuccess: () => void invalidate(),
  });
  const addPick = useMutation({
    ...trpc.discovery.addPick.mutationOptions(),
    onSuccess: () => {
      setManual("");
      void invalidate();
    },
  });

  const rows = picks.data ?? [];

  return (
    <>
      <h2>CNAEs alvo</h2>
      <p className="lede" style={{ marginBottom: 8 }}>
        Toda sugestão é conferida contra a tabela oficial e contra a contagem real antes de
        aparecer. O modelo inventa código: pedindo “ensino médio” ele já respondeu{" "}
        <code>8599</code> — que é “Formação de condutores”.
      </p>

      <div className="panel">
        <div className="row">
          <button
            className="btn"
            disabled={suggest.isPending}
            onClick={() => suggest.mutate({ projectId })}
          >
            {suggest.isPending ? "Perguntando…" : "Sugerir CNAEs"}
            <small>gasta LLM · 1 chamada</small>
          </button>
          <input
            className="inp"
            style={{ maxWidth: 150 }}
            placeholder="ou digite um código"
            value={manual}
            onChange={(e) => setManual(e.target.value.replace(/\D/g, ""))}
          />
          <button
            className="btn"
            disabled={manual.length < 2 || addPick.isPending}
            onClick={() => addPick.mutate({ projectId, cnae: manual })}
          >
            Adicionar
          </button>
          <span className="muted">as contagens são grátis: vêm do Parquet local</span>
        </div>
        <ErrorBox error={suggest.error ?? addPick.error} />
      </div>

      {rows.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>usar</th>
                <th>cnae</th>
                <th>situação</th>
                <th>descrição oficial</th>
                <th className="num">empresas</th>
                <th className="num">com telefone</th>
                <th className="num">abertas 24m</th>
                <th>por quê</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const s = STATUS_LABEL[p.status] ?? STATUS_LABEL.unknown!;
                return (
                  <tr key={p.cnae}>
                    <td>
                      <input
                        type="checkbox"
                        checked={p.chosen}
                        disabled={p.status !== "ok"}
                        onChange={(e) =>
                          setChosen.mutate({
                            projectId,
                            cnae: p.cnae,
                            chosen: e.target.checked,
                          })
                        }
                      />
                    </td>
                    <td>
                      <code>{p.cnae}</code>
                    </td>
                    <td>
                      <span className={`chip ${s.chip}`}>{s.text}</span>
                    </td>
                    <td className="wrap">
                      {p.descricao ?? (
                        <span className="muted">não existe na tabela oficial de CNAEs</span>
                      )}
                    </td>
                    <td className="num">
                      <Num v={p.reachTotal} />
                    </td>
                    <td className="num">
                      <Num v={p.reachWithPhone} />
                    </td>
                    <td className="num">
                      <Num v={p.reachRecent} />
                    </td>
                    <td className="wrap muted">{p.rationale}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
