"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * The four steps, in the order the work happens. Each carries the current
 * project in the query string, so switching tabs never loses your place.
 */
const TABS = [
  { href: "/", label: "Projeto" },
  { href: "/discovery", label: "Descoberta" },
  { href: "/enrichment", label: "Enriquecimento" },
  { href: "/scoring", label: "Pontuação" },
  { href: "/leads", label: "Leads" },
];

export function Tabs() {
  const pathname = usePathname();
  const params = useSearchParams();
  const project = params.get("project");
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";

  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <Link key={t.href} href={`${t.href}${qs}`} data-active={pathname === t.href}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
