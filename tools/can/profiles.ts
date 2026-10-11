// Generates src/nav/odometry/can/signals.json: the layout of every message and signal the per-make mappings
// (src/nav/odometry/can/mappings.ts) reference, from the opendbc submodule's DBCs. Checks each reference and the DBC's
// unit against the mapping's.
//
//   git submodule update --init tools/can/opendbc
//   npm run can:profiles
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DbcSignals, SignalDef, SignalsFile } from "@/nav/odometry/can/dbc";
import { MAKES, type Mapping, type SignalRef, type SpeedUnit } from "@/nav/odometry/can/mappings";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../src/nav/odometry/can/signals.json");

interface ParsedSignal {
  def: SignalDef;
  unit: string;
}

interface ParsedMessage {
  id: number;
  size: number;
  sigs: Map<string, ParsedSignal>;
}

interface ParsedDbc {
  msgs: Map<string, ParsedMessage>;
  /** "id.SIG" → value → label */
  values: Map<string, Record<string, string>>;
}

// The same patterns as opendbc/can/dbc.py.
const BO_RE = /^BO_ (\w+) (\w+) *: (\w+) (\w+)/;
const SG_RE = /^SG_ (\w+)(?: (\w+))? *: (\d+)\|(\d+)@(\d)([+-]) \(([0-9.+\-eE]+),([0-9.+\-eE]+)\) \[[0-9.+\-eE]+\|[0-9.+\-eE]+\] "(.*)"/;
const VAL_RE = /^VAL_ (\w+) (\w+) (.*);/;

function parseDbc(text: string): ParsedDbc {
  const msgs = new Map<string, ParsedMessage>();
  const byId = new Map<number, ParsedMessage>();
  const values = new Map<string, Record<string, string>>();
  let current: ParsedMessage | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("BO_ ")) {
      const m = BO_RE.exec(line);
      if (!m) continue;
      current = { id: Number(m[1]), size: Number(m[3]), sigs: new Map() };
      msgs.set(m[2], current);
      byId.set(current.id, current);
    } else if (line.startsWith("SG_ ") && current) {
      const m = SG_RE.exec(line);
      if (!m) continue;
      const [, name, , start, size, order, sign, factor, offset, unit] = m;
      current.sigs.set(name, {
        def: [Number(start), Number(size), order === "1" ? 1 : 0, sign === "-" ? 1 : 0, Number(factor), Number(offset)],
        unit,
      });
    } else if (line.startsWith("VAL_ ")) {
      const m = VAL_RE.exec(line);
      if (!m) continue;
      const table: Record<string, string> = {};
      for (const [, value, label] of m[3].matchAll(/(-?\d+) "([^"]*)"/g)) table[value] = label;
      values.set(`${Number(m[1])}.${m[2]}`, table);
    }
  }
  return { msgs, values };
}

const UNIT_WORDS: Record<SpeedUnit, RegExp> = {
  kph: /^(km\/?h|kph|kmh|Unit_KiloMeterPerHour)$/i,
  mph: /^mph$/i,
  mps: /^m\/s$/i,
};

function refs(mapping: Mapping): { quantity: string; ref: SignalRef; alt: number; unit?: SpeedUnit }[] {
  const out: { quantity: string; ref: SignalRef; alt: number; unit?: SpeedUnit }[] = [];
  const add = (quantity: string, alt: number, ref: SignalRef, unit?: SpeedUnit, extra: string[] = []) => {
    out.push({ quantity, ref, alt, unit });
    for (const sig of extra) out.push({ quantity, ref: { msg: ref.msg, sig }, alt });
  };
  if (mapping.wheels) {
    for (const w of ["fl", "fr", "rl", "rr"] as const) {
      const wheel = mapping.wheels[w];
      add("wheels", 0, wheel, mapping.wheels.unit);
      if (wheel.dir) add("wheels", 0, wheel.dir);
    }
  }
  mapping.speed?.forEach((s, i) => add("speed", i, s, s.unit, [s.plus, s.signSig].filter((x): x is string => !!x)));
  mapping.gear?.forEach((g, i) => add("gear", i, g));
  mapping.steer?.forEach((s, i) => add("steer", i, s, undefined, [s.plus, s.signSig].filter((x): x is string => !!x)));
  mapping.brake?.forEach((b, i) => add("brake", i, b));
  mapping.yaw?.forEach((s, i) => add("yaw", i, s, undefined, [s.plus, s.signSig].filter((x): x is string => !!x)));
  return out;
}

function main() {
  const opendbc = path.join(HERE, "opendbc");
  const commit = execFileSync("git", ["-C", opendbc, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const texts = JSON.parse(
    execFileSync("python", [path.join(HERE, "dump_dbcs.py")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
  ) as Record<string, string>;

  const out: SignalsFile = { opendbc: commit, dbcs: {} };
  const errors: string[] = [];
  const warnings: string[] = [];
  const dbcNames = new Set<string>();
  for (const make of MAKES) {
    for (const mapping of make.mappings) {
      const where = `${make.make}/${mapping.name}`;
      const all = refs(mapping);
      const found = new Set<string>();
      for (const dbcName of mapping.dbcs) {
        if (dbcNames.has(dbcName)) errors.push(`${where}: ${dbcName} is mapped twice`);
        dbcNames.add(dbcName);
        const text = texts[dbcName];
        if (!text) {
          errors.push(`${where}: no DBC ${dbcName} in opendbc`);
          continue;
        }
        const dbc = parseDbc(text);
        const target: DbcSignals = (out.dbcs[dbcName] = { msgs: {} });
        // An alternative is kept for this DBC only when all its signals are there.
        const missing = new Set<string>();
        for (const { quantity, ref, alt } of all) {
          if (!dbc.msgs.get(ref.msg)?.sigs.has(ref.sig)) missing.add(`${quantity}.${alt}`);
        }
        const kept = new Set<string>();
        for (const { quantity, ref, alt, unit } of all) {
          if (missing.has(`${quantity}.${alt}`)) continue;
          kept.add(quantity);
          found.add(`${quantity}.${alt}`);
          const msg = dbc.msgs.get(ref.msg)!;
          const sig = msg.sigs.get(ref.sig)!;
          const m = (target.msgs[ref.msg] ??= { id: msg.id, size: msg.size, sigs: {} });
          m.sigs[ref.sig] = sig.def;
          if (unit && sig.unit && !UNIT_WORDS[unit].test(sig.unit)) {
            warnings.push(`${where} ${dbcName}: ${ref.msg}.${ref.sig} is "${sig.unit}" in the DBC, mapped as ${unit}`);
          }
          const values = dbc.values.get(`${msg.id}.${ref.sig}`);
          const gear = quantity === "gear" ? mapping.gear?.[alt] : undefined;
          if (gear?.kind === "selector" && !gear.values) {
            if (values) (target.values ??= {})[`${ref.msg}.${ref.sig}`] = values;
            else errors.push(`${where} ${dbcName}: ${ref.msg}.${ref.sig} has no value table; give the gear values`);
          }
        }
        for (const quantity of new Set(all.map((r) => r.quantity))) {
          if (!kept.has(quantity)) warnings.push(`${where} ${dbcName}: no ${quantity} source in this DBC`);
        }
      }
      for (const { quantity, ref, alt } of all) {
        if (!found.has(`${quantity}.${alt}`)) errors.push(`${where}: ${quantity} ${ref.msg}.${ref.sig} is in none of its DBCs`);
      }
    }
  }
  for (const w of [...new Set(warnings)]) console.warn(`warning: ${w}`);
  if (errors.length) {
    for (const e of [...new Set(errors)]) console.error(`error: ${e}`);
    process.exit(1);
  }
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const msgs = Object.values(out.dbcs).reduce((n, d) => n + Object.keys(d.msgs).length, 0);
  console.log(`${path.relative(process.cwd(), OUT)}: ${Object.keys(out.dbcs).length} DBCs, ${msgs} messages (opendbc ${commit.slice(0, 10)})`);
}

main();
