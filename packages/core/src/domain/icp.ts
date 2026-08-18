/**
 * What a written ideal-customer profile became, criterion by criterion.
 *
 * Pure vocabulary, no I/O: the compiler produces it, the database stores it and
 * both front ends render it, so it lives with the rest of the shared shapes
 * rather than inside the use-case that happens to fill it in.
 *
 * `mapped: false` is the load-bearing case. The Receita base has no headcount,
 * no revenue and no tooling, so a profile asking for them yields a filter that
 * does not exist — and a shortlist the operator reads as narrower than it is.
 */
export interface IcpCriterion {
  /** The criterion in the operator's own words. */
  criterion: string;
  mapped: boolean;
  /**
   * Where it landed ("CNAE 8520", "excludeMei", "probe: portal do aluno"), or
   * why it could not ("a base não traz número de funcionários").
   */
  mappedTo: string;
}
