export * from "./domain/index";
export * from "./ports/index";
export { createOpenRouterLlm, DEFAULT_MODELS, LlmError } from "./adapters/openrouter";
export { compileSpec, type CompileInput, type CompileResult } from "./usecases/compileSpec";
export { suggestCnaes, type CnaeSuggestion } from "./usecases/suggestCnaes";
export {
  scoreCompanies,
  renderCandidate,
  type ScoreCandidate,
  type ScoreResult,
} from "./usecases/scoreCompanies";
export {
  crawlSite,
  analyzeHtml,
  websiteFromEmail,
  phoneFromHtml,
  parseRobots,
  robotsAllows,
  HostThrottle,
  describeFetchError,
  mapLimit,
  type SiteSignals,
  type CrawlOptions,
} from "./usecases/crawl";
