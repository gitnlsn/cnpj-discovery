import type { IcpCriterion, ProjectSpec } from "@cnpj/core";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * What the written profile became, criterion by criterion.
 *
 * The `não deu` rows are the reason this exists. The Receita has no headcount,
 * no revenue and no tech stack, so a criterion asking for one cannot become a
 * filter — and without saying so, the list silently comes out broader than the
 * profile asked for. It used to be buried under two forms; now it leads.
 */
export function IcpCoverageCard({ spec }: { spec: ProjectSpec }) {
  const unmapped = spec.icpCoverage.filter((c) => !c.mapped).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Do seu perfil de cliente ideal</CardTitle>
        <CardDescription>
          {unmapped > 0 ? (
            <>
              {unmapped} critério{unmapped > 1 ? "s" : ""} não virou filtro. A triagem desses é
              sua, na revisão.
            </>
          ) : (
            "Todos os critérios viraram filtro."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table className="table-dense">
          <TableHeader>
            <TableRow>
              <TableHead className="w-28 pl-6">situação</TableHead>
              <TableHead>critério</TableHead>
              <TableHead>onde entrou</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spec.icpCoverage.map((c: IcpCriterion, i: number) => (
              <TableRow key={i}>
                <TableCell className="pl-6">
                  <Badge variant={c.mapped ? "secondary" : "destructive"}>
                    {c.mapped ? "filtro" : "não deu"}
                  </Badge>
                </TableCell>
                <TableCell>{c.criterion}</TableCell>
                <TableCell className="text-muted-foreground">
                  {c.mappedTo || (
                    <span className="italic">
                      {c.mapped ? "sem detalhe" : "a base da Receita não tem esse dado"}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {spec.icpCoverage.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="pl-6 text-muted-foreground">
                  nenhum critério registrado
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
