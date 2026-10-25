// An iPhone simulator on the newest iOS runtime that has one: reads `xcrun simctl list devices available -j` on stdin,
// prints its udid (nothing when there is none).
const { devices } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const version = (runtime) => runtime.match(/SimRuntime\.iOS-([\d-]+)$/)?.[1].split("-").map(Number);
const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};
let best = null;
for (const [runtime, list] of Object.entries(devices)) {
  const v = version(runtime);
  const phone = list.find((d) => d.name.startsWith("iPhone"));
  if (v && phone && (!best || newer(v, best.v))) best = { v, udid: phone.udid };
}
if (best) console.log(best.udid);
