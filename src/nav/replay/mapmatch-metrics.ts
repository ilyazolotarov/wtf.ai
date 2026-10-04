// Map-matching metrics against the ground truth (MAPMATCH-SPEC §10.2), sampled during a replay.

import type { RoadGraph } from "../mapmatch/graph/road-graph";
import type { ParticleFilter } from "../mapmatch/particle-filter";
import type { MapMatchEstimate } from "../navigator";
import { isSameRoad, type TruthMatch } from "./truth-match";

export interface MapMatchSummary {
  /** Moving samples (at the replay's track step) where the truth knows the road and the filter runs, past `init`. */
  samples: number;
  /** Samples in state `init` (heading unknown, not tracked yet): only truth survival counts them. */
  initSamples: number;
  /** Share of samples whose dominant cluster is not on the true road. */
  wrongRoadRate: number | null;
  /** Share of samples, `init` included, with at least one particle on the true road. */
  truthSurvival: number | null;
  multimodalShare: number | null;
  offRoadShare: number | null;
  /** From entering multimodal to tracking on the true road. */
  relock: { count: number; medianS: number | null; maxS: number | null; medianM: number | null; maxM: number | null };
  /** Filter update durations (odometry chunk or fix), ms. */
  updateMs: { p50: number; p99: number; max: number } | null;
  /** Samples whose dominant cluster was on a wrong road, as [start, end] stretches in seconds since log start. */
  wrongRoad: [number, number][];
  /** Samples with no particle on the true road. */
  lost: [number, number][];
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export class MapMatchMetrics {
  private samples = 0;
  private initSamples = 0;
  private wrong = 0;
  private survived = 0;
  private multimodal = 0;
  private offRoad = 0;
  private multimodalSince: { tUs: number; distanceM: number } | null = null;
  private relocks: { s: number; m: number }[] = [];
  private wrongSpans: [number, number][] = [];
  private lostSpans: [number, number][] = [];

  constructor(
    private readonly graph: Pick<RoadGraph, "edge">,
    private readonly truth: TruthMatch,
    private readonly startUs: number,
  ) {}

  /** One sample: call while the car moves. */
  sample(tUs: number, estimate: MapMatchEstimate | undefined, pf: ParticleFilter | null, distanceM: number): void {
    if (!estimate || estimate.state === "off" || !pf) return;
    const truth = this.truth.at(tUs);
    if (!truth) return;
    const tS = (tUs - this.startUs) / 1e6;
    const survived = pf.someParticle((edge) => isSameRoad(this.graph, truth, edge));
    if (survived) this.survived++;
    else extend(this.lostSpans, tS);
    if (estimate.state === "init") {
      // The start is still ambiguous by design (MAPMATCH-SPEC §8): only survival is scored.
      this.initSamples++;
      return;
    }
    this.samples++;
    const top = estimate.clusters[0];
    const onTruth = !!top?.edge && isSameRoad(this.graph, truth, top.edge);
    if (!onTruth) {
      this.wrong++;
      extend(this.wrongSpans, tS);
    }
    if (estimate.state === "multimodal") {
      this.multimodal++;
      this.multimodalSince ??= { tUs, distanceM };
    } else if (estimate.state === "offroad") {
      this.offRoad++;
    }
    if (estimate.state === "tracking" && onTruth && this.multimodalSince) {
      this.relocks.push({ s: (tUs - this.multimodalSince.tUs) / 1e6, m: distanceM - this.multimodalSince.distanceM });
      this.multimodalSince = null;
    }
  }

  summary(updateTimes: number[]): MapMatchSummary {
    const n = this.samples;
    const share = (k: number) => (n ? k / n : null);
    const all = n + this.initSamples;
    const s = this.relocks.map((r) => r.s);
    const m = this.relocks.map((r) => r.m);
    return {
      samples: n,
      initSamples: this.initSamples,
      wrongRoadRate: share(this.wrong),
      truthSurvival: all ? this.survived / all : null,
      multimodalShare: share(this.multimodal),
      offRoadShare: share(this.offRoad),
      relock: {
        count: this.relocks.length,
        medianS: s.length ? quantile(s, 0.5) : null,
        maxS: s.length ? Math.max(...s) : null,
        medianM: m.length ? quantile(m, 0.5) : null,
        maxM: m.length ? Math.max(...m) : null,
      },
      updateMs: updateTimes.length ? { p50: quantile(updateTimes, 0.5), p99: quantile(updateTimes, 0.99), max: Math.max(...updateTimes) } : null,
      wrongRoad: this.wrongSpans,
      lost: this.lostSpans,
    };
  }
}

/** Grow the last span when `tS` follows it closely, else start a new one. */
function extend(spans: [number, number][], tS: number): void {
  const last = spans.at(-1);
  if (last && tS - last[1] <= 2.5) last[1] = tS;
  else spans.push([tS, tS]);
}
