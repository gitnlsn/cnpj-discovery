export * from "./domain/index";
export * from "./ports/index";
export { createOpenRouterLlm, DEFAULT_MODELS, LlmError } from "./adapters/openrouter";
export {
  compileSpec,
  compileTargeting,
  compileRubric,
  isTargetingDraft,
  type CompileInput,
  type CompileResult,
  type TargetingDraft,
} from "./usecases/compileSpec";
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
  emailsFromHtml,
  phonesFromHtml,
  parseRobots,
  robotsAllows,
  HostThrottle,
  mapLimit,
  type SiteSignals,
  type CrawlOptions,
} from "./usecases/crawl";
export {
  createGooglePlaces,
  placesQuery,
  discoveryQuery,
  PlacesError,
  WEBSITE_FIELD_MASK,
  DISCOVERY_FIELD_MASK,
  PLACES_SKU,
  PLACES_MAX_RESULTS,
  type PlaceWebsite,
  type PlaceBusiness,
  type PlaceSearchPage,
} from "./adapters/googlePlaces";
export {
  Budget,
  BudgetExceededError,
  FREE_MONTHLY,
  PRICE_PER_1K,
  estimateCost,
  type BudgetCounters,
} from "./services/budget";
export {
  classifyRateLimit,
  backoffMs,
  dailyLimitAdvice,
  type RateLimitKind,
} from "./services/rateLimit";
export { createFallbackLlm, type FallbackOptions, type LlmLink } from "./adapters/fallback";
export {
  createGeminiLlm,
  toGeminiSchema,
  GEMINI_DEFAULT_MODELS,
  GeminiError,
} from "./adapters/gemini";

export {
  createDdgSearch,
  DdgError,
  DDG_SKU,
  type DdgSearchOptions,
} from "./adapters/ddgSearch";
export {
  findPresence,
  verifyHits,
  BlockStreak,
  type PresenceHit,
  type PresenceOutcome,
  type PresenceProvider,
  type PresenceCompany,
} from "./usecases/findPresence";
export {
  enrichLinkedIn,
  planFetch,
  orderPlans,
  hasSubstance,
  type LinkedInCandidate,
  type LinkedInPlan,
  type LinkedInFetcher,
  type LinkedInStore,
  type LinkedInStop,
  type LinkedInEnrichStats,
  type EnrichOptions,
} from "./usecases/enrichLinkedIn";
