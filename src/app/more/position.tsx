import { useEffect, useState } from "react";

import { ScreenAction, ScreenContent, ScreenRow, ScreenSection } from "@/components/screens/screen-ui";
import { useNavStatus } from "@/components/status/use-nav-status";
import { dash, fmt } from "@/components/vehicle/format";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRuntime, useSensorSnapshot } from "@/providers/runtime-provider";

/** Position diagnostics: integrity, live GNSS, the EKF, map matching and routing on this phone. */
export default function PositionScreen() {
  const { t } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const { position } = nav;
  const { sensors, position: navigator, routes } = useRuntime();
  const sensor = useSensorSnapshot();
  // Ticks every second while the sheet is up; also re-reads the EKF below.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const fixAge = position ? `${Math.max(0, Math.floor((clock - position.timestamp) / 1000))} s` : dash;
  const heading =
    position?.headingRad == null ? dash : `${Math.round((position.headingRad * 180) / Math.PI)}°`;
  const ekf = navigator.getDebug();
  const routing = routes.getDebug();
  const route = routes.getSnapshot();
  const num = (v: number | null, digits: number, unit = "") => (v === null ? dash : `${v.toFixed(digits)}${unit}`);

  return (
    <ScreenContent title={t("position")}>
      <ScreenSection title={t("integrity")}>
        <ScreenRow labelKey="recorderState" value={nav.trust} valueColor={nav.color.c} />
        <ScreenRow labelKey="positionSource" value={nav.source} />
      </ScreenSection>

      <ScreenSection title={t("liveGnss")}>
        <ScreenRow labelKey="latitude" value={position?.lat.toFixed(6) ?? dash} />
        <ScreenRow labelKey="longitude" value={position?.lon.toFixed(6) ?? dash} />
        <ScreenRow labelKey="accuracy" value={position ? `${position.accuracyM.toFixed(1)} m` : dash} />
        <ScreenRow labelKey="speedAccuracy" value={fmt(sensor.lastFix?.speedAccMps, 2, "m/s")} />
        <ScreenRow
          labelKey="speed"
          value={position?.speedMps == null ? dash : `${(position.speedMps * 3.6).toFixed(1)} km/h`}
        />
        <ScreenRow labelKey="heading" value={heading} />
        <ScreenRow labelKey="fixAge" value={fixAge} />
        <ScreenRow labelKey="gnssRate" value={sensor.gnssRunning ? fmt(sensor.gnssHz, 1, "Hz") : dash} />
        <ScreenRow labelKey="imuRate" value={sensor.imuRunning ? fmt(sensor.imuHz, 0, "Hz") : dash} />
        {sensor.lastError && <ScreenRow labelKey="lastError" value={sensor.lastError} valueColor={palette.bad.c} />}
      </ScreenSection>
      {sensor.permission !== "whenInUse" && sensor.permission !== "always" && (
        <ScreenAction labelKey="allowLocation" secondary onPress={() => void sensors.requestPermission()} />
      )}

      <ScreenSection title={t("ekfState")}>
        <ScreenRow label="mode" value={`${ekf.mode}${ekf.source ? ` · ${ekf.source}` : ""}`} />
        <ScreenRow label="ψ σ" value={num(ekf.headingSigmaDeg, 1, "°")} />
        <ScreenRow label="kₛ" value={ekf.speedScale === null ? dash : `${ekf.speedScale.toFixed(4)} ±${ekf.speedScaleSigma!.toFixed(4)}`} />
        <ScreenRow label="bω" value={num(ekf.gyroBiasDegS, 4, " °/s")} />
        <ScreenRow label="kω" value={num(ekf.gyroScale, 4)} />
        <ScreenRow label="GNSS lag" value={`${num(ekf.gnssLagS, 2, " s")}${ekf.gnssLagWindows ? ` (${ekf.gnssLagWindows} turns)` : ""}`} />
        <ScreenRow label="parked pose" value={ekf.parkedPose} />
        <ScreenRow
          label="compass (shadow)"
          value={`${ekf.compassTrust}${ekf.compassOffDeg === null ? "" : ` · ${ekf.compassOffDeg.toFixed(0)}° off`}`}
        />
      </ScreenSection>

      <ScreenSection title={t("mapMatching")}>
        <ScreenRow label="road graph" value={ekf.mapMatchRegion ?? dash} />
        <ScreenRow label="feeds back" value={t(ekf.mapMatchLoop === "open" ? "loopOpen" : ekf.mapMatchLoop === "heading" ? "loopHeading" : "loopClosed")} />
        {ekf.mapMatchLoop !== "open" && (
          <ScreenRow
            label="road corrections"
            value={ekf.roadHeading && ekf.roadPosition
              ? `heading ${ekf.roadHeading.accepted} · position ${ekf.roadPosition.accepted}` +
                (ekf.roadHeading.rejected + ekf.roadPosition.rejected ? ` · ${ekf.roadHeading.rejected + ekf.roadPosition.rejected} refused` : "")
              : dash}
          />
        )}
        <ScreenRow
          label="state"
          value={ekf.mapMatch ? `${ekf.mapMatch.state} · ${ekf.mapMatch.particles} particles` : ekf.mapMatchRegion ? "off" : dash}
        />
        <ScreenRow
          label="hypotheses"
          value={ekf.mapMatch?.clusters.length ? ekf.mapMatch.clusters.map((c) => `${Math.round(c.weight * 100)}%`).join(" · ") : dash}
        />
        <ScreenRow label="update (last)" value={ekf.mapMatch && ekf.mapMatchTiming ? `${ekf.mapMatch.updateMs.toFixed(2)} ms` : dash} />
        {/* Every update this drive; the target is under 5 ms at p99 (MAPMATCH-SPEC §14), judged from 100 updates on
            (fewer make p99 the slowest one). */}
        <ScreenRow
          label="update p50 / p99"
          value={ekf.mapMatchTiming ? `${ekf.mapMatchTiming.p50Ms.toFixed(2)} / ${ekf.mapMatchTiming.p99Ms.toFixed(2)} ms` : dash}
        />
        <ScreenRow
          label="slowest · over 5 ms"
          value={ekf.mapMatchTiming ? `${ekf.mapMatchTiming.maxMs.toFixed(1)} ms · ${ekf.mapMatchTiming.overBudget} of ${ekf.mapMatchTiming.count}` : dash}
          valueColor={ekf.mapMatchTiming && ekf.mapMatchTiming.count >= 100 && ekf.mapMatchTiming.p99Ms > 5 ? palette.bad.c : undefined}
        />
        {/* Starts apart: the first reads the roads around the car from storage, once a drive. */}
        <ScreenRow
          label="starts · slowest"
          value={ekf.mapMatchStarts ? `${ekf.mapMatchStarts.count} · ${ekf.mapMatchStarts.maxMs.toFixed(1)} ms` : dash}
        />
        <ScreenRow
          label="share of time"
          value={ekf.mapMatchTiming ? `${(ekf.mapMatchTiming.share * 100).toFixed(2)} %` : dash}
        />
      </ScreenSection>

      {/* Routing on this phone (ROUTING-SPEC §8.2): the last plan's cost, and guidance now. */}
      <ScreenSection title={t("routing")}>
        <ScreenRow label="plans" value={routing.plans ? String(routing.plans) : dash} />
        <ScreenRow
          label="last plan"
          value={routing.last ? `#${routing.last.id} ${routing.last.reason} · ${routing.last.outcome === "done" ? `${((routing.last.lengthM ?? 0) / 1000).toFixed(1)} km` : routing.last.outcome}` : dash}
          valueColor={routing.last && routing.last.outcome !== "done" ? palette.bad.c : undefined}
        />
        <ScreenRow
          label="planning · wall"
          value={routing.last ? `${Math.round(routing.last.planMs)} ms · ${Math.round(routing.last.wallMs)} ms` : dash}
        />
        <ScreenRow
          label="states · tiles · slices"
          value={routing.last ? `${routing.last.states} · ${routing.last.tiles} · ${routing.last.slices}` : dash}
        />
        <ScreenRow label="slice size" value={`${routing.sliceStates} states`} />
        <ScreenRow
          label="guidance"
          value={route?.guidance ? `${route.guidance.state} · ${Number.isFinite(route.guidance.offM) ? `${Math.round(route.guidance.offM)} m off` : "no match"}` : route ? route.status : dash}
        />
      </ScreenSection>
    </ScreenContent>
  );
}
