// What a real junction looks like to the matcher: every edge within a radius, with its class, heading and
// distance, and the exits at the node the car turns through. Used to shape the test fixture on a real junction
// (MAPMATCH-SPEC §15, item 14) instead of guessing at its density.
// Usage: npm run replay:junction -- --at <lat>,<lon> [--radius <m>] [--graph <file.graph.bin>]

import { LocalFrame } from "../../src/nav/geo/local-frame";
import { RoadClass } from "../../src/nav/mapmatch/graph/format";
import { findGraph, openGraph } from "./graph-file";

function parseArgs(argv: string[]) {
  let at: { lat: number; lon: number } | undefined;
  let radiusM = 150;
  let graph: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--at") {
      const [lat, lon] = argv[++i].split(",").map(Number);
      at = { lat, lon };
    } else if (argv[i] === "--radius") radiusM = Number(argv[++i]);
    else if (argv[i] === "--graph") graph = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("replay:junction -- --at <lat>,<lon> [--radius <m>] [--graph <file.graph.bin>]");
      process.exit(0);
    }
  }
  if (!at) throw new Error("--at <lat>,<lon> is required");
  return { at, radiusM, graph };
}

const DEG = 180 / Math.PI;
const CLASS_NAME = Object.fromEntries(Object.entries(RoadClass).map(([k, v]) => [v, k]));
const className = (c: number) => CLASS_NAME[c] ?? String(c);

const { at, radiusM, graph: graphArg } = parseArgs(process.argv.slice(2));
const graphFile = graphArg ?? findGraph(at);
if (!graphFile) throw new Error("no graph covers that point");
const { graph } = openGraph(graphFile, at);
const frame = new LocalFrame(at);
graph.setFrame(frame);
const [e0, n0] = frame.toEnu(at);

const near = graph.edgesNear(e0, n0, radiusM);
console.log(`${near.length} edges within ${radiusM} m of the junction (graph ${graphFile}):`);
const seen = new Set<number>();
for (const x of near) {
  if (seen.has(x.edge.id)) continue;
  seen.add(x.edge.id);
  console.log(
    `  way ${String(x.edge.wayId).padStart(12)}  ${className(x.edge.cls).padEnd(13)}  ` +
      `${x.distanceM.toFixed(0).padStart(4)} m off, heading ${((x.headingRad * DEG + 360) % 360).toFixed(0).padStart(3)}°, ` +
      `oneway ${x.edge.oneway}, flags ${x.edge.flags}, ${x.edge.lengthM.toFixed(0)} m long`,
  );
}

// The exits the filter can choose from at the nearest edge, both directions.
const nearest = near[0];
if (nearest) {
  for (const dir of [1, -1] as const) {
    const exits = graph.exits(nearest.edge.id, dir);
    console.log(`\nexits from way ${nearest.edge.wayId} dir ${dir}: ${exits.length}`);
    for (const x of exits) {
      const to = graph.edge(x.edge);
      console.log(
        `  -> way ${String(to.wayId).padStart(12)} ${className(to.cls).padEnd(13)} ` +
          `${x.uTurn ? "u-turn " : ""}${x.againstOneway ? "against-oneway " : ""}${x.restricted ? "restricted " : ""}`,
      );
    }
  }
}
