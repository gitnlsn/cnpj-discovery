"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Building2, FolderKanban, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectSwitcher } from "@/components/project-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Tabs follow the data model, not the pipeline.
 *
 * Two things are managed: a project (its ICP, its rubric, the CNAEs it targets)
 * and the companies under it. Enriching, scoring and flagging are verbs applied
 * to companies, so they belong on the company row — not in tabs of their own.
 */
const TABS = [
  { href: "/", label: "Projetos", Icon: FolderKanban },
  { href: "/companies", label: "Empresas", Icon: Building2 },
  // A terceira aba não é outra ETAPA, é outra ENTIDADE: um negócio achado na web
  // que pode não ter CNPJ nenhum, e que por isso não cabe em `companies`. É o
  // mesmo critério das outras duas — a aba segue o modelo de dados.
  { href: "/openweb", label: "Internet aberta", Icon: Globe },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const project = params.get("project");
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <Link href={`/${qs}`} className="text-sm font-semibold tracking-tight">
          cnpj<span className="text-muted-foreground">-discovery</span>
        </Link>

        <ProjectSwitcher />

        <nav className="flex items-center gap-0.5">
          {TABS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={`${href}${qs}`}
              data-active={pathname === href}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium",
                "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "data-[active=true]:bg-muted data-[active=true]:text-foreground"
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex-1" />
        <ThemeToggle />
      </header>

      <main className="flex-1 px-4 py-4">{children}</main>
    </div>
  );
}
