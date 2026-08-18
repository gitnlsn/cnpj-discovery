"use client";

import { useRouter, useSearchParams } from "next/navigation";

/** The current project id, and a setter that keeps it in the URL. */
export function useProject(): [string | null, (id: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const current = params.get("project");
  return [
    current,
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set("project", id);
      router.push(`?${next.toString()}`);
    },
  ];
}

export function Tier({ tier }: { tier: string | null }) {
  if (!tier) return <span className="muted">—</span>;
  return <span className={`chip chip-${tier}`}>{tier}</span>;
}

export function Num({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">—</span>;
  return <>{v.toLocaleString("pt-BR")}</>;
}

/**
 * A dash, not a zero, for "not measured yet".
 *
 * `0` is a claim about the world; `—` says we have not looked. Rendering the
 * two the same is how a half-finished run gets read as a finished one.
 */
export function Maybe({ v }: { v: number | null | undefined }) {
  return v == null ? <span className="muted">—</span> : <>{v.toLocaleString("pt-BR")}</>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="err">{message}</div>;
}

export function NoProject() {
  return (
    <div className="panel">
      <p className="muted" style={{ margin: 0 }}>
        Escolha ou crie um projeto na aba <b>Projeto</b> primeiro.
      </p>
    </div>
  );
}
