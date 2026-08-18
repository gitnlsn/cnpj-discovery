"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * The active project, kept in the URL.
 *
 * In the URL rather than in a context so every view is linkable and a reload
 * lands you back where you were — the same reason the filters live there too.
 */
export function useProject(): [string | null, (id: string) => void] {
  const params = useSearchParams();
  const router = useRouter();

  return [
    params.get("project"),
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set("project", id);
      router.push(`?${next.toString()}`);
    },
  ];
}
