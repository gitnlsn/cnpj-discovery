"use client";

import { ChevronRight } from "lucide-react";
import type { Axis, Probe, ProjectSpec } from "@cnpj/core";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const LEVELS = ["5", "4", "3", "2", "1"] as const;

/**
 * The rubric each company is graded against.
 *
 * Collapsed by default: the anchors matter when you are questioning a score,
 * not while you are scanning the list, and five levels times three axes is a
 * wall of text if it is always open.
 */
export function RubricCard({ spec }: { spec: ProjectSpec }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{spec.summary}</CardTitle>
        <CardDescription>
          Quem decide: {spec.buyer} · Problema: {spec.problem}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {spec.rubric.axes.map((axis: Axis) => (
          <Collapsible key={axis.key} className="rounded-md border">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className="font-medium">{axis.label}</span>
              <span className="truncate text-muted-foreground">{axis.question}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-2">
              <dl className="space-y-1 text-sm">
                {LEVELS.map((level) => (
                  <div key={level} className="flex gap-2">
                    <dt className="w-5 shrink-0 font-mono text-muted-foreground">{level}</dt>
                    <dd>{axis.anchors[level]}</dd>
                  </div>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        ))}

        {spec.probes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-sm text-muted-foreground">Sinais procurados na página:</span>
            {spec.probes.map((p: Probe) => (
              <Badge key={p.key} variant="outline" className="font-normal">
                {p.label}
              </Badge>
            ))}
          </div>
        )}

        {spec.rubric.notes.length > 0 && (
          <ul className="list-inside list-disc pt-1 text-sm text-muted-foreground">
            {spec.rubric.notes.map((n: string, i: number) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
