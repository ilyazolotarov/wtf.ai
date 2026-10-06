// Lets Node run the app's TypeScript directly (with --experimental-transform-types):
// resolves the `@/` alias and extensionless relative imports to .ts files.
// Also lowers the tool's CPU priority, so a benchmark on every core never makes the desktop unresponsive.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { constants, setPriority } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The tools take every core but one (pool.ts) and may run several at once: at low priority they get whatever the
// desktop leaves, which is all of it while nobody uses the PC. The viewer is interactive, so only below normal.
// Per process on Windows; per thread on Linux, where each worker thread loads this file too.
try {
  const viewer = process.argv[1]?.endsWith(path.join("viewer", "server.ts"));
  setPriority(0, viewer ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_LOW);
} catch {
  // Not allowed here: run at the normal priority.
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function tsFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    const file = base && tsFile(base);
    if (file) return nextResolve(pathToFileURL(file).href, context);
    return nextResolve(specifier, context);
  },
});
