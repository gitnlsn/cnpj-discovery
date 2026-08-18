"use client";

import {
  MoreHorizontal,
  Phone,
  Globe,
  Sparkles,
  Flag,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CompanyRow } from "@/lib/api-types";

/**
 * Per-row actions.
 *
 * The same verbs the selection bar applies in bulk, for when you want just one
 * — kept in a menu so the table stays scannable instead of carrying five
 * buttons per row.
 */
export function CompanyRowActions({
  row,
  onReveal,
  onCrawl,
  onScore,
  onFlag,
  onRemove,
}: {
  row: CompanyRow;
  onReveal: () => void;
  onCrawl: () => void;
  onScore: () => void;
  onFlag: () => void;
  onRemove: () => void;
}) {
  const site = row.crawl?.finalUrl ?? row.places?.websiteUrl ?? row.guessedSite;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-60 hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
          aria-label="Ações"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="font-mono text-xs font-normal">
          {row.company.cnpj}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onReveal}>
          <Phone className="size-3.5" />
          Revelar telefone
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCrawl} disabled={!site}>
          <Globe className="size-3.5" />
          Visitar site
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onScore}>
          <Sparkles className="size-3.5" />
          Pontuar
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onFlag} disabled={Boolean(row.lead)}>
          <Flag className="size-3.5" />
          {row.lead ? "Já é lead" : "Marcar como lead"}
        </DropdownMenuItem>
        {site && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={site} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-3.5" />
                Abrir site
              </a>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash2 className="size-3.5" />
          Remover do projeto
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
