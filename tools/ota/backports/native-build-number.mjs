// Backport (docs/OTA.md → Backporting a fix): the app's build number from Sentry's native module instead of
// `Constants.nativeBuildVersion`, which expo-constants no longer has. Without it the app never knew its build and
// never offered a native update (UPDATES-SPEC §3).
//
//   node tools/ota/backports/native-build-number.mjs <checkout>
//
// Copies src/services/native-build-number.ts into <checkout> and rewrites every `Constants.nativeBuildVersion` in
// its src/ to `nativeBuild()`, dropping the expo-constants import where nothing else uses it.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HERE = path.resolve(import.meta.dirname, "../../..");
const target = process.argv[2];
if (!target) throw new Error("usage: native-build-number.mjs <checkout>");
const src = path.join(path.resolve(target), "src");

const HELPER = "src/services/native-build-number.ts";
if (path.resolve(target) !== HERE) copyFileSync(path.join(HERE, HELPER), path.join(path.resolve(target), HELPER));

const CONSTANTS_IMPORT = /^import Constants from "expo-constants";\r?\n/m;
const OLD = "Constants.nativeBuildVersion";

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : files(path.join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );

const changed = [];
for (const file of files(src)) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(OLD)) continue;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next = text.replaceAll(OLD, "nativeBuild()");
  if (!CONSTANTS_IMPORT.test(next)) throw new Error(`${file}: no expo-constants import to put the new one beside`);
  const keepConstants = /\bConstants\b/.test(next.replace(CONSTANTS_IMPORT, ""));
  next = next.replace(
    CONSTANTS_IMPORT,
    (line) => (keepConstants ? line : "") + `import { nativeBuild } from "@/services/native-build-number";${eol}`,
  );
  writeFileSync(file, next);
  changed.push(path.relative(path.resolve(target), file).replaceAll("\\", "/"));
}

// The update check is the point: without it the backport would change nothing that matters.
if (!changed.includes("src/services/app-update/native-build.ts")) {
  throw new Error("src/services/app-update/native-build.ts doesn't read Constants.nativeBuildVersion: nothing to backport");
}
console.log(`native build number: ${changed.join(", ")}`);
