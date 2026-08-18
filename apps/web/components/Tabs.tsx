"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Tabs follow the data model, not the pipeline.
 *
 * There are two things you actually manage: a project (its ICP, its compiled
 * spec, the CNAEs it targets) and the companies under it. Everything the
 * pipeline does — enrich, score, flag — is an *action on a company*, so it
 * belongs on the company row rather than in a tab of its own. Splitting by
 * stage meant four screens that each showed the same rows in a different state
 * and made you navigate to change which verb you could apply.
 *
 * `cnae_picks` is keyed (project_id, cnae): a pick has no meaning without a
 * project, so it lives inside Projetos as part of targeting.
 */
const TABS = [
  { href: "/", label: "Projetos" },
  { href: "/companies", label: "Empresas" },
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
