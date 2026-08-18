import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

/** Portuguese labels for the lead pipeline states. */
export const LEAD_LABEL = {
  flagged: "marcado",
  contacted: "contatado",
  replied: "respondeu",
  won: "fechou",
  lost: "não deu",
} as const;

export type LeadStatus = keyof typeof LEAD_LABEL;
export const LEAD_STATUSES = Object.keys(LEAD_LABEL) as LeadStatus[];

export const LEAD_VARIANT: Record<LeadStatus, BadgeVariant> = {
  flagged: "secondary",
  contacted: "outline",
  replied: "default",
  won: "default",
  lost: "destructive",
};

/** Classes for a score band. Both themes are defined, so neither is a fallback. */
export const TIER_CLASS: Record<string, string> = {
  hot: "bg-tier-hot-bg text-tier-hot border-transparent",
  warm: "bg-tier-warm-bg text-tier-warm border-transparent",
  cold: "bg-tier-cold-bg text-tier-cold border-transparent",
};

export function nf(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("pt-BR");
}

/**
 * An em dash for "not measured", never a zero.
 *
 * `0` is a claim about the world; `—` says nobody has looked. Rendering them
 * the same is how a half-finished run reads as a finished one.
 */
export function maybe(v: number | null | undefined): string {
  return v == null ? "—" : String(v);
}

export function shortUrl(url: string | null | undefined, max = 34): string {
  if (!url) return "";
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

export function dateBr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR");
}

export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
