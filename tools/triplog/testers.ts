// Upload codes for the app's trip log upload (TRIP-LOGGER-SPEC §7.1), kept in the private bucket.
//
//   npm run testers:add -- <name> [--owner]   prints a new code once; --owner: logs go to logs/, not logs/testers/<name>/
//   npm run testers:list
//   npm run testers:remove -- <name>          the code stops working at once; the tester's logs stay
//
// The bucket holds only each code's SHA-256 (testers/<hash>.json, read by workers/triplog-upload), so a lost code
// can't be shown again: remove the tester and add them anew.
import { randomBytes } from "node:crypto";

import { formatCode, generateCode, testerKey, TESTER_NAME_RE, type TesterRecord } from "../../src/triplog/upload-protocol";
import { credentials, listRemote, s3, sha256, type Creds } from "./s3";

async function testers(c: Creds): Promise<{ key: string; record: TesterRecord }[]> {
  const out = [];
  for (const { key } of (await listRemote(c, "testers/")).values()) {
    const record = (await (await s3(c, "GET", `testers/${key}`)).json()) as TesterRecord;
    out.push({ key: `testers/${key}`, record });
  }
  return out.sort((a, b) => a.record.created.localeCompare(b.record.created));
}

async function main() {
  const [command, name] = process.argv.slice(2);
  const c = credentials();
  if (command === "list") {
    const all = await testers(c);
    if (!all.length) console.log("No testers yet: npm run testers:add -- <name>");
    for (const { record: r } of all) console.log(`${r.name.padEnd(20)} ${r.owner ? "owner  → logs/" : `tester → logs/testers/${r.name}/`}  since ${r.created.slice(0, 10)}`);
  } else if (command === "add") {
    if (!name || !TESTER_NAME_RE.test(name)) throw new Error("usage: npm run testers:add -- <name> [--owner]  (name: lowercase letters, digits, dashes)");
    const all = await testers(c);
    if (all.some((t) => t.record.name === name)) throw new Error(`${name} already has a code: npm run testers:remove -- ${name} first`);
    const owner = process.argv.includes("--owner");
    const code = generateCode((n) => new Uint8Array(randomBytes(n)));
    const record: TesterRecord = { name, ...(owner ? { owner: true } : {}), created: new Date().toISOString() };
    await s3(c, "PUT", testerKey(sha256(code)), { body: Buffer.from(JSON.stringify(record)), headers: { "content-type": "application/json" } });
    console.log(`Code for ${name}${owner ? " (owner: logs go next to yours)" : ""}:\n\n    ${formatCode(code)}\n`);
    console.log("It is shown only now. In the app: Settings → Trip log upload.");
  } else if (command === "remove") {
    const found = (await testers(c)).filter((t) => t.record.name === name);
    if (!found.length) throw new Error(`no tester named ${name ?? "(none given)"}`);
    for (const t of found) await s3(c, "DELETE", t.key);
    console.log(`${name}'s code no longer works. Their logs stay in logs/testers/${name}/.`);
  } else {
    throw new Error("usage: testers.ts add <name> [--owner] | list | remove <name>");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
