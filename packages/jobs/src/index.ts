import { eq, and, desc } from "drizzle-orm";
import { jobs, type Db } from "@cnpj/db";

/**
 * Long work, run in this process, with progress in the `jobs` table.
 *
 * The previous project spawned its CLI as a subprocess for this, because a
 * thirty-minute Receita load inside `next dev` dies on the first file save.
 * That reasoning is honoured differently here: the load lives in
 * `scripts/sync-rf.ts` and never enters the web app at all, which leaves only
 * crawling and scoring — minutes, not hours, and both resumable a chunk at a
 * time. So they run in-process and there is no argv to escape.
 */

export type JobKind =
  | "compile"
  | "discover"
  | "crawl"
  | "score"
  | "places"
  | "pipeline"
  | "continuous"
  | "search"
  | "openweb";

/**
 * Which resource a job competes for. One running job per lane, not one overall.
 *
 * The original rule was one job, period, and the reason was real: two crawls of
 * the same project would fight over the same rows, and two fast clicks must not
 * both win. But that rule also blocked the two things a person actually wants at
 * once — working the companies of a project while a sweep of the open internet
 * looks for companies that are not in it yet. Those touch different tables,
 * different Chrome profiles and different verbs.
 *
 * So the lock is now per lane. `receita` keeps the old guarantee exactly, for
 * every job that reads the Receita base or writes a company's rows. `openweb`
 * is the sweep, which owns `web_leads` and nothing else.
 *
 * What the lanes still share, and what that costs, is written down in
 * `docs`-free form here because there is nowhere better: the SERP daily budget
 * and the LLM request cap are global, so two lanes drain them twice as fast —
 * which is why the discovery sweep has its own sub-cap rather than its own
 * ceiling. Chrome is NOT shared: the two lanes must use different
 * `userDataDir`s, because Puppeteer cannot open the same profile twice. That is
 * a hard requirement of running these together, not a preference.
 */
export type JobLane = "receita" | "openweb";

export function laneOf(kind: JobKind): JobLane {
  return kind === "openweb" ? "openweb" : "receita";
}

export interface JobProgress {
  done: number;
  total: number;
  note?: string;
}

export interface JobHandle {
  id: number;
}

/** Thrown when a job is already running. The database decides, not JavaScript. */
export class JobBusyError extends Error {
  constructor(lane?: JobLane) {
    // Naming the lane matters: "já existe um trabalho rodando" while the other
    // tab is visibly idle reads as a bug. Saying which lane is busy says which
    // button to wait on.
    super(
      lane === "openweb"
        ? "Já existe uma varredura da internet aberta rodando. Espere ela terminar ou cancele."
        : "Já existe um trabalho rodando nas empresas. Espere ele terminar ou cancele."
    );
    this.name = "JobBusyError";
  }
}

export interface JobContext {
  progress(p: JobProgress): void;
  log(line: string): void;
  /** True once someone asked to cancel. Long loops should check it. */
  cancelled(): boolean;
}

const cancelling = new Set<number>();

/**
 * Starts a job and returns as soon as it has an id.
 *
 * Concurrency is refused by `jobs_one_running_idx`, a partial unique index on
 * `(status, lane)`, so two fast clicks cannot both win — a JavaScript guard
 * would lose that race. Per lane, so an open-internet sweep and the work on a
 * project's companies can run at the same time; see `JobLane`.
 */
export function startJob(
  db: Db,
  kind: JobKind,
  projectId: string | null,
  run: (ctx: JobContext) => Promise<unknown>
): JobHandle {
  const lane = laneOf(kind);
  let id: number;
  try {
    const [row] = db
      .insert(jobs)
      .values({ kind, lane, projectId, status: "running", progress: { done: 0, total: 0 } })
      .returning({ id: jobs.id })
      .all();
    if (!row) throw new Error("não consegui criar o job");
    id = row.id;
  } catch (err) {
    if (String(err).includes("UNIQUE") || String(err).includes("constraint")) {
      throw new JobBusyError(lane);
    }
    throw err;
  }

  let log = "";
  const ctx: JobContext = {
    progress(p) {
      db.update(jobs).set({ progress: p }).where(eq(jobs.id, id)).run();
    },
    log(line) {
      // Capped: a log nobody truncates becomes the largest column in the file.
      log = `${log}${line}\n`.slice(-16_000);
      db.update(jobs).set({ log }).where(eq(jobs.id, id)).run();
    },
    cancelled: () => cancelling.has(id),
  };

  // Deliberately not awaited: the caller gets an id and polls.
  void (async () => {
    try {
      await run(ctx);
      db.update(jobs)
        .set({
          status: cancelling.has(id) ? "cancelled" : "done",
          finishedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, id))
        .run();
    } catch (err) {
      db.update(jobs)
        .set({
          status: "failed",
          error: (err as Error).message.slice(0, 2000),
          finishedAt: new Date().toISOString(),
        })
        .where(eq(jobs.id, id))
        .run();
    } finally {
      cancelling.delete(id);
    }
  })();

  return { id };
}

/**
 * Asks a running job to stop.
 *
 * Cooperative, not forced: the flag lives in this process and the job checks it
 * between chunks. There is nothing to signal — the work is a loop here, not a
 * child process.
 */
export function cancelJob(db: Db, id: number): boolean {
  const job = getJob(db, id);
  if (!job || job.status !== "running") return false;
  cancelling.add(id);
  return true;
}

/**
 * The running job in one lane. Defaults to `receita`, which is what every
 * caller written before lanes existed meant by "the current job".
 */
export function currentJob(db: Db, lane: JobLane = "receita") {
  const [row] = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "running"), eq(jobs.lane, lane)))
    .limit(1)
    .all();
  return row ?? null;
}

/** Every running job, at most one per lane. */
export function runningJobs(db: Db) {
  return db.select().from(jobs).where(eq(jobs.status, "running")).all();
}

export function recentJobs(db: Db, limit = 10) {
  return db.select().from(jobs).orderBy(desc(jobs.startedAt)).limit(limit).all();
}

export function getJob(db: Db, id: number) {
  const [row] = db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all();
  return row ?? null;
}

/**
 * Clears a `running` row left behind by a dev-server restart.
 *
 * In-process jobs do not survive a reload, so any `running` row older than the
 * process is a ghost holding the single-job lock forever.
 */
export function reconcileStaleJobs(db: Db): number {
  const stale = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "running")).all();
  if (stale.length === 0) return 0;
  db.update(jobs)
    .set({
      status: "failed",
      error: "interrompido por reinício do servidor",
      finishedAt: new Date().toISOString(),
    })
    .where(eq(jobs.status, "running"))
    .run();
  return stale.length;
}
