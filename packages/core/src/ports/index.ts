/**
 * The boundaries the domain does not own.
 *
 * Nothing under `src/` reads `process.env`, writes to `console`, or opens a
 * socket of its own. It declares what it needs here and the app hands it over.
 * That is what lets a scoring test run the real prompt against a stub model
 * without a network, an API key, or a mock that agrees with whatever the code
 * happens to do.
 */

export type Task = "compile" | "score" | "suggest";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  task: Task;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  /** A JSON Schema. Sent as response_format when the model supports it. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  retries?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  structured: boolean;
}

export interface LlmPort {
  complete(o: CompleteOptions): Promise<{ text: string; usage: Usage; model: string }>;
  completeJson<T>(o: CompleteOptions): Promise<{ value: T; usage: Usage; model: string }>;
  modelFor(task: Task): string;
  listFreeModels(): Promise<ModelInfo[]>;
}

export interface HttpPort {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const nodeHttp: HttpPort = { fetch: (url, init) => fetch(url, init) };

/** Progress reporting. The CLI prints it; the web app writes it to `jobs`. */
export interface Progress {
  stage(label: string): void;
  tick(done: number, total?: number, note?: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export const silentProgress: Progress = {
  stage: () => {},
  tick: () => {},
  info: () => {},
  warn: () => {},
};
