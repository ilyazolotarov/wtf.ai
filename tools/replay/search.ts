// Address search on the PC (SEARCH-SPEC §7): the app's SearchIndex over a `<region>.search.bin`.
//
//   npm run search -- <file.search.bin> "Шевченка 10" ["Миру" …] [--near 51.49,31.29] [--limit 10]
//
// Prints each query's results and how long it took (first query: the token table loads too).

import { performance } from "node:perf_hooks";

import { SearchIndex } from "../../src/nav/search/search-index";
import { fileByteSource } from "./graph-file";

function main(argv: string[]) {
  const args = [...argv];
  let near: { lat: number; lon: number } | null = null;
  let limit = 10;
  const take = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const nearArg = take("--near");
  if (nearArg) {
    const [lat, lon] = nearArg.split(",").map(Number);
    near = { lat, lon };
  }
  const limitArg = take("--limit");
  if (limitArg) limit = Number(limitArg);
  const [file, ...queries] = args;
  if (!file || queries.length === 0) {
    console.error('usage: npm run search -- <file.search.bin> "query" [...] [--near lat,lon] [--limit n]');
    process.exit(2);
  }
  const source = fileByteSource(file);
  const t0 = performance.now();
  const index = new SearchIndex(source);
  const h = index.header;
  console.log(
    `${file}: OSM ${h.osmDate}, ${h.entities} entities (${h.settlements} settlements), ${h.addresses} addresses, ` +
      `${h.tokens} tokens; opened in ${(performance.now() - t0).toFixed(1)} ms`,
  );
  for (const query of queries) {
    const t = performance.now();
    const results = index.search(query, { near, limit });
    const ms = performance.now() - t;
    console.log(`\n"${query}": ${results.length} results in ${ms.toFixed(1)} ms`);
    for (const r of results) {
      const where = r.settlement ? ` · ${r.settlement.name}` : "";
      const house = r.house ? `, ${r.house}` : "";
      console.log(
        `  ${r.score.toFixed(1).padStart(6)}  ${r.kind.padEnd(7)} ${r.name}${house}${where}  ` +
          `[${r.tag}] ${r.lat.toFixed(5)},${r.lon.toFixed(5)}`,
      );
    }
  }
  source.close();
}

main(process.argv.slice(2));
