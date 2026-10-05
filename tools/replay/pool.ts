// Runs replay jobs on worker threads: the benchmarks replay hundreds of windows and seeds, each on one core.
// A tool module calls `new Pool(import.meta.url, threads)` in the main thread and `serveJobs(import.meta.url, run)` at
// its top level: a worker loads that same module (so it shares the code, and caches trips and graphs across the jobs
// it gets) and only that module answers, even when it imports another tool that serves jobs too. Results come back in
// job order, so output doesn't depend on timing.
// Threads: `--threads <n>` on the tool's command line, else all cores but one.

import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export { isMainThread };

/** `--threads <n>` from the command line (removed from `argv`), else all cores but one. */
export function threadsArg(argv: string[]): number {
  const i = argv.indexOf("--threads");
  if (i < 0) return Math.max(1, availableParallelism() - 1);
  const n = Number(argv[i + 1]);
  if (!(Number.isInteger(n) && n >= 1)) throw new Error("--threads takes a whole number ≥ 1");
  argv.splice(i, 2);
  return n;
}

type Reply<R> = { i: number; result: R } | { i: number; error: string };

export class Pool {
  private readonly workers: Worker[] = [];

  constructor(
    private readonly script: string,
    private readonly threads: number,
  ) {}

  /** Runs every job (on up to `threads` workers) and returns the results in job order. */
  async map<J, R>(jobs: J[]): Promise<R[]> {
    const results = new Array<R>(jobs.length);
    let next = 0;
    let done = 0;
    while (this.workers.length < Math.min(this.threads, jobs.length)) {
      // The worker inherits this process's flags (the TypeScript loader); jobs carry everything else.
      this.workers.push(new Worker(fileURLToPath(this.script), { workerData: { script: this.script } }));
    }
    if (!jobs.length) return results;
    return new Promise((resolve, reject) => {
      const feed = (w: Worker) => {
        if (next < jobs.length) w.postMessage({ i: next, job: jobs[next++] });
      };
      for (const w of this.workers) {
        w.removeAllListeners("message").removeAllListeners("error");
        w.on("message", (m: Reply<R>) => {
          if ("error" in m) {
            reject(new Error(m.error));
            return;
          }
          results[m.i] = m.result;
          if (++done === jobs.length) resolve(results);
          else feed(w);
        });
        w.on("error", reject);
        feed(w);
      }
    });
  }

  close(): Promise<number[]> {
    return Promise.all(this.workers.splice(0).map((w) => w.terminate()));
  }
}

/** In a worker started for `script` (the caller's `import.meta.url`): answers each job with `run(job)`. Else nothing. */
export function serveJobs<J, R>(script: string, run: (job: J) => R): void {
  if (isMainThread || (workerData as { script?: string } | null)?.script !== script) return;
  parentPort!.on("message", ({ i, job }: { i: number; job: J }) => {
    try {
      parentPort!.postMessage({ i, result: run(job) });
    } catch (e) {
      parentPort!.postMessage({ i, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  });
}
