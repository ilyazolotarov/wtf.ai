// An iPhone simulator on the newest iOS runtime that has one: reads `xcrun simctl list devices available -j` on stdin,
// prints its udid (nothing when there is none). With a version argument ("26.4"), the newest runtime below it, when
// there is one: the iOS 26.5 simulator's CarPlay crashes on every map template (CARPLAY-SPEC §6.2).
const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const below = process.argv[2]?.split(".").map(Number);
const version = (runtime) => runtime.match(/SimRuntime\.iOS-([\d-]+)$/)?.[1].split("-").map(Number);
const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};
const pick = (accept) => {
  let best = null;
  for (const [runtime, list] of Object.entries(devices)) {
    const v = version(runtime);
    const phone = list.find((d) => d.name.startsWith("iPhone"));
    if (v && phone && accept(v) && (!best || newer(v, best.v))) best = { v, udid: phone.udid, name: phone.name };
  }
  return best;
};
let best = below ? pick((v) => newer(below, v)) : null;
if (below && !best) console.error(`No iOS runtime below ${below.join(".")}: the newest instead`);
best ??= pick(() => true);
if (best) {
  console.error(`${best.name}, iOS ${best.v.join(".")}`);
  console.log(best.udid);
}
