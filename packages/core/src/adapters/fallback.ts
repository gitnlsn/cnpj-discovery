import type { CompleteOptions, LlmPort, ModelInfo, Task } from "../ports/index";

/**
 * One `LlmPort` made of several, tried in order.
 *
 * The reason this exists is the 503 the compile step kept ending on: Gemini
 * answers `503 The model is overloaded` on its free tier, and it is not a quota
 * — it is Google's capacity for that model at that minute. Retrying against the
 * same model rides out a blip but not a bad ten minutes, and `compile` is the
 * worst-hit task because it is two large structured calls back to back on the
 * heavier `flash` model, either of which failing loses both.
 *
 * A second provider is the only retry that changes anything, because its
 * capacity and its daily quota are somebody else's. So the ports are chained
 * rather than the requests repeated.
 *
 * Each link keeps its own throttle, which is why the chain must only hold ports
 * of DIFFERENT providers. Two clients for one provider would each think they
 * are the only caller and fire back to back into the same per-minute ceiling.
 */
export interface LlmLink {
  /** Shown in logs and in the error when the whole chain fails. */
  name: string;
  port: LlmPort;
  /**
   * Retries for this link only. Worth lowering on the first link: its default
   * of 4 spends over a minute of backoff before the chain even reaches a
   * provider that would have answered, and `compile` is a button press someone
   * is watching.
   */
  retries?: number;
}

export interface FallbackOptions {
  links: LlmLink[];
  /** Called when a link fails and the next one is about to be tried. */
  onFallback?: (info: { from: string; to: string; task: Task; error: Error }) => void;
}

/**
 * Falls over on ANY error from a link, not only on 503 and 429.
 *
 * The alternative — a list of retryable statuses — decides for the user that a
 * 400 or a malformed answer is worth failing on rather than asking the other
 * provider about. Every reason a link fails is a reason to ask the next one,
 * and the schemas here are provider-agnostic on purpose. Nothing is hidden:
 * when the last link fails too, its error carries what each earlier link said.
 */
export function createFallbackLlm(opts: FallbackOptions): LlmPort {
  const links = opts.links;
  if (!links.length) throw new Error("createFallbackLlm precisa de pelo menos um provedor");
  const [first] = links as [LlmLink, ...LlmLink[]];
  if (links.length === 1) return first.port;

  async function attempt<T>(task: Task, run: (link: LlmLink) => Promise<T>): Promise<T> {
    const failures: string[] = [];

    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      try {
        return await run(link);
      } catch (err) {
        const error = err as Error;
        const next = links[i + 1];
        if (!next) {
          // Rethrown as-is, message extended: callers read `error.message` to
          // tell a daily cap from a transient one, and the earlier links' text
          // is exactly what that reading needs. Mutating it keeps the class and
          // its `status` intact.
          if (failures.length) {
            error.message = `${failures.join(" | ")} | ${link.name}: ${error.message}`;
          }
          throw error;
        }
        failures.push(`${link.name}: ${error.message}`);
        opts.onFallback?.({ from: link.name, to: next.name, task, error });
      }
    }

    // Unreachable: the loop either returns or throws on the last link.
    throw new Error("nenhum provedor respondeu");
  }

  return {
    complete: (o: CompleteOptions) =>
      attempt(o.task, (l) =>
        l.port.complete(l.retries === undefined ? o : { ...o, retries: l.retries })
      ),

    completeJson: <T>(o: CompleteOptions) =>
      attempt(o.task, (l) =>
        l.port.completeJson<T>(l.retries === undefined ? o : { ...o, retries: l.retries })
      ),

    // The first link is the answer to "which model is this", because it is the
    // one that will run unless something goes wrong. A caller that stores the
    // model reads it off the completed call, which reports the real one.
    modelFor: (task: Task) => first.port.modelFor(task),

    listFreeModels: (): Promise<ModelInfo[]> => first.port.listFreeModels(),
  };
}
