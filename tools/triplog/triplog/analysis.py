"""Summaries, sanity checks, and ECU refresh-period estimation for trip logs."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .reader import Trip

EARTH_R = 6_371_000.0


def _rate_hz(t: pd.Series) -> float:
    if len(t) < 2:
        return 0.0
    span = float(t.iloc[-1] - t.iloc[0])
    return (len(t) - 1) / span if span > 0 else 0.0


def satellite_fix(gnss: pd.DataFrame) -> pd.Series:
    """Fixes with a satellite lock. Under GNSS jamming iOS falls back to Wi-Fi/cell
    positions, which carry no speed; the 50 m gate matches the recorder's distance."""
    return (gnss["speed"] >= 0) & (gnss["h_acc"] < 50)


def gnss_distance_m(gnss: pd.DataFrame) -> float:
    """Sum of hops between consecutive fixes that both have a satellite lock."""
    if len(gnss) < 2:
        return 0.0
    lat = np.radians(gnss["lat"].to_numpy())
    lon = np.radians(gnss["lon"].to_numpy())
    dlat = np.diff(lat)
    dlon = np.diff(lon)
    a = np.sin(dlat / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(dlon / 2) ** 2
    good = satellite_fix(gnss).to_numpy()
    return float(np.sum((2 * EARTH_R * np.arcsin(np.sqrt(a)))[good[:-1] & good[1:]]))


def summary(trip: Trip) -> dict:
    ok_speed = trip.obd_speed[trip.obd_speed["status"] == "ok"]
    return {
        "file": str(trip.path),
        "trip_id": trip.info.get("trip_id"),
        "start_utc": str(trip.to_utc(0.0)) if len(trip.time_sync) else None,
        "duration_s": round(trip.duration_s, 1),
        "complete": trip.complete,
        "start_reason": trip.info.get("start_reason"),
        "end_reason": (trip.trip_events[trip.trip_events["event"] == "end"]["reason"].tolist() or [None])[-1],
        "gnss_distance_km": round(gnss_distance_m(trip.gnss) / 1000, 3),
        "gnss_satellite_fixes": f"{int(satellite_fix(trip.gnss).sum())}/{len(trip.gnss)}",
        "adapter": {
            "transport": trip.info.get("adapter_transport"),
            "name": trip.info.get("adapter_name"),
            "elm": trip.info.get("adapter_elm"),
            "chip": trip.info.get("adapter_chip"),
            "protocol": trip.info.get("obd_protocol"),
        },
        "vin": trip.info.get("vehicle_vin"),
        "rates_hz": {
            "obd_speed": round(_rate_hz(ok_speed["t_s"]), 2),
            "gnss": round(_rate_hz(trip.gnss["t_s"]), 2),
            "imu": round(_rate_hz(trip.imu["t_s"]), 2),
        },
        "obd_speed_errors": int((trip.obd_speed["status"] != "ok").sum()),
        "obd_latency_ms_p50": float(np.nanmedian(ok_speed["latency_ms"])) if len(ok_speed) else None,
        "imu_max_gap_s": float(trip.imu["t_s"].diff().max()) if len(trip.imu) > 1 else None,
        "dropouts_ms": trip.dropouts_ms,
        "map_match_timing": map_match_timing(trip),
        "routing": routing(trip),
    }


def map_match_timing(trip: Trip, budget_ms: float = 5.0) -> dict | None:
    """How long the app's particle-filter updates took (MAPMATCH-SPEC §11), from `nav_mapmatch`.

    Rows carry the count, total and slowest of the updates since the previous row, so the
    slowest update is exact; p99 is of those per-row maxima (an upper bound on the true p99).
    """
    mm = trip.map_match
    if not len(mm) or "updates" not in mm or not mm["updates"].sum():
        return None
    rows = mm[mm["updates"] > 0]
    span_s = float(mm["t_s"].iloc[-1] - mm["t_s"].iloc[0]) if len(mm) > 1 else 0.0
    total_ms = float(rows["updates_total_ms"].sum())
    return {
        "updates": int(rows["updates"].sum()),
        "mean_ms": round(total_ms / int(rows["updates"].sum()), 3),
        "row_max_p50_ms": round(float(rows["updates_max_ms"].quantile(0.5)), 3),
        "row_max_p99_ms": round(float(rows["updates_max_ms"].quantile(0.99)), 3),
        "max_ms": round(float(rows["updates_max_ms"].max()), 3),
        "rows_over_budget": int((rows["updates_max_ms"] > budget_ms).sum()),
        "share_of_time": round(total_ms / (span_s * 1000), 5) if span_s > 0 else None,
    }


def routing(trip: Trip) -> dict | None:
    """Routes the app planned on the drive and how guidance went (ROUTING-SPEC §8.3), from the `nav_route*` records."""
    plans = trip.route
    if not len(plans):
        return None
    made = plans[plans["reason"] != "resume"]
    done = made[made["status"] == "done"]
    progress = trip.route_progress
    states = progress["state"].tolist() if len(progress) else []
    went_off = sum(1 for i, st in enumerate(states) if st == "off" and (i == 0 or states[i - 1] != "off"))
    arrived = trip.transcript[trip.transcript["text"].str.startswith("route arrived")]
    return {
        "plans": int(len(made)),
        "reasons": made["reason"].value_counts().to_dict(),
        "failed": made[made["status"] != "done"]["status"].tolist(),
        "plan_ms_max": round(float(done["plan_ms"].max()), 1) if len(done) else None,
        "wall_ms_max": round(float(done["wall_ms"].max()), 1) if len(done) else None,
        "first_km": round(float(done["length_m"].iloc[0]) / 1000, 2) if len(done) else None,
        "first_planned_min": round(float(done["duration_s"].iloc[0]) / 60, 1) if len(done) else None,
        "share_by_state": {k: round(v / len(states), 4) for k, v in pd.Series(states).value_counts().items()} if states else {},
        "went_off": went_off,
        "arrived": arrived["text"].iloc[0] if len(arrived) else None,
    }


@dataclass
class Finding:
    level: str  # "ok" | "warn" | "fail"
    message: str


def speed_agreement(trip: Trip, min_speed_mps: float = 5.0, max_speed_acc: float = 1.0) -> pd.DataFrame:
    """OBD speed vs GNSS speed (interpolated at OBD sample times) where GNSS is good."""
    sp = trip.obd_speed[trip.obd_speed["status"] == "ok"]
    g = trip.gnss[(trip.gnss["speed"] >= 0) & (trip.gnss["speed_acc"].fillna(0) <= max_speed_acc)]
    if len(sp) == 0 or len(g) < 2:
        return pd.DataFrame(columns=["t_s", "obd_kph", "gnss_kph", "diff_kph"])
    gnss_at = np.interp(sp["t_s"], g["t_s"], g["speed"], left=np.nan, right=np.nan)
    df = pd.DataFrame({"t_s": sp["t_s"].to_numpy(), "obd_kph": sp["raw_kph"].to_numpy(), "gnss_kph": gnss_at * 3.6})
    df = df[df["gnss_kph"] >= min_speed_mps * 3.6]
    df["diff_kph"] = df["obd_kph"] - df["gnss_kph"]
    return df


def check(trip: Trip) -> list[Finding]:
    out: list[Finding] = []
    for name, df in trip.streams().items():
        if "t_s" in df and len(df) > 1 and name not in ("transcript", "obd"):
            backwards = int((df["t_s"].diff() < 0).sum())
            if backwards:
                out.append(Finding("fail", f"{name}: {backwards} timestamps go backwards"))
    if not trip.complete:
        out.append(Finding("warn", "incomplete trip (no trip_event end) — app killed or still recording"))
    s = summary(trip)
    rates = s["rates_hz"]
    if len(trip.imu):
        out.append(Finding("ok" if rates["imu"] >= 90 else "warn", f"IMU rate {rates['imu']} Hz (expected ~100)"))
        gap = s["imu_max_gap_s"] or 0
        out.append(Finding("ok" if gap <= 1.0 else "warn", f"IMU max gap {gap:.3f} s"))
    else:
        out.append(Finding("warn", "no IMU data"))
    if len(trip.gnss):
        out.append(Finding("ok" if 0.5 <= rates["gnss"] <= 2 else "warn", f"GNSS rate {rates['gnss']} Hz (expected ~1)"))
        n_sat = int(satellite_fix(trip.gnss).sum())
        if n_sat == 0:
            out.append(Finding("warn", f"no satellite lock in {len(trip.gnss)} GNSS fixes (no speed): jamming or no sky view"))
        elif n_sat < len(trip.gnss):
            out.append(Finding("ok", f"{n_sat}/{len(trip.gnss)} GNSS fixes with satellite lock"))
    else:
        out.append(Finding("warn", "no GNSS data"))
    if len(trip.obd_speed):
        out.append(Finding("ok" if rates["obd_speed"] >= 5 else "warn", f"OBD speed rate {rates['obd_speed']} Hz"))
        agree = speed_agreement(trip)
        if not satellite_fix(trip.gnss).any():
            pass  # reported above; nothing to compare against
        elif len(agree) >= 20:
            med = float(np.median(agree["diff_kph"]))
            mad = float(np.median(np.abs(agree["diff_kph"] - med)))
            level = "ok" if abs(med) <= 1.0 else "warn"
            out.append(Finding(level, f"OBD − GNSS speed: median {med:+.2f} km/h, MAD {mad:.2f} km/h over {len(agree)} samples"))
        else:
            out.append(Finding("warn", "not enough moving samples with good GNSS for speed agreement"))
    else:
        out.append(Finding("warn", "no OBD speed data"))
    if trip.dropouts_ms:
        out.append(Finding("warn", f"{len(trip.dropouts_ms)} dropouts, {sum(trip.dropouts_ms)} ms total"))
    return out


@dataclass
class RefreshEstimate:
    period_s: float | None
    coherence: float
    n_changes: int
    poll_period_s: float
    suggested_cap_hz: float | None
    note: str


def estimate_refresh(trips: list[Trip], min_period_s: float = 0.01, max_period_s: float = 0.5) -> RefreshEstimate:
    """Estimate the ECU refresh period of PID 0D (VEHICLE-LINK-SPEC §10.2).

    The value can only change at ECU update instants, so value-change times cluster on a
    grid of the refresh period. Change instants are taken between the last old and first
    new sample. For each candidate period P we compute phase coherence
    R(P) = |mean(exp(2πi·t/P))| over 30 s windows (to tolerate clock drift) and pick the
    largest P whose coherence is close to the best one (sub-multiples of P are coherent too).
    """
    changes: list[np.ndarray] = []
    poll_periods = []
    for trip in trips:
        sp = trip.obd_speed[trip.obd_speed["status"] == "ok"]
        if len(sp) < 3:
            continue
        t = sp["t_s"].to_numpy()
        v = sp["raw_kph"].to_numpy()
        poll_periods.append(np.median(np.diff(t)))
        idx = np.nonzero(np.diff(v) != 0)[0]
        changes.append((t[idx] + t[idx + 1]) / 2)
    if not changes:
        return RefreshEstimate(None, 0.0, 0, float("nan"), None, "no OBD speed samples")
    poll = float(np.median(poll_periods))
    n = int(sum(len(c) for c in changes))
    if n < 30:
        return RefreshEstimate(None, 0.0, n, poll, None, "too few value changes (drive with acceleration/braking)")

    candidates = np.arange(min_period_s, max_period_s, 0.001)
    scores = np.zeros_like(candidates)
    weights = 0
    for c in changes:
        for w0 in np.arange(c.min(), c.max(), 30.0):
            win = c[(c >= w0) & (c < w0 + 30.0)]
            if len(win) < 5:
                continue
            phase = 2j * np.pi * win[None, :] / candidates[:, None]
            scores += np.abs(np.exp(phase).mean(axis=1)) * len(win)
            weights += len(win)
    if weights == 0:
        return RefreshEstimate(None, 0.0, n, poll, None, "changes too sparse per window")
    scores /= weights
    best = float(scores.max())
    if best < 0.3:
        return RefreshEstimate(None, best, n, poll, None, "no periodic structure (poll period too coarse vs refresh, or jitter)")
    good = candidates[scores >= 0.9 * best]
    period = float(good.max())
    note = "poll faster than refresh: estimate reliable" if poll < period / 1.5 else "poll period close to refresh: estimate uncertain"
    # Polling at 2/P sees each ECU update within half a refresh period.
    return RefreshEstimate(period, best, n, poll, round(2.0 / period, 1), note)
