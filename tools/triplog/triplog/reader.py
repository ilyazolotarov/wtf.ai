"""Load a wtf.ai ULog trip log into pandas DataFrames.

Schema: docs/TRIP-LOGGER-SPEC.md §6 (wtf_log_ver 1). All `t_s` columns are seconds
since the log start on the phone's monotonic clock; `to_utc()` maps them to wall time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from pyulog import ULog

SUPPORTED_LOG_VERSIONS = {1}

OBD_STATUS = [
    "ok",
    "no-data",
    "timeout",
    "unable-to-connect",
    "bus-error",
    "unknown-command",
    "stopped",
    "buffer-full",
    "parse-error",
    "other",
]
ENGINE_STATES = ["unknown", "ignition-off", "engine-off", "engine-running"]
TRIP_EVENTS = ["start", "end", "link_lost", "link_restored", "marker", "preroll_end"]
END_REASONS = ["ignition_off", "parked_timeout", "link_timeout", "manual"]
LINK_STATES = [
    "idle",
    "discovering",
    "connecting",
    "probing",
    "standby",
    "initializing",
    "polling",
    "reconnecting",
    "error",
]
LOG_TAGS = {1: "elm", 2: "link", 3: "trip", 4: "sensors", 5: "app"}
LOG_LEVELS = {ord("3"): "error", ord("4"): "warning", ord("6"): "info", ord("7"): "debug"}

PID_SPEED = 0x0D
PID_RPM = 0x0C


def _name(table: list[str], code: int) -> str:
    return table[code] if 0 <= code < len(table) else f"code_{code}"


@dataclass
class Trip:
    path: Path
    start_us: int
    info: dict
    obd: pd.DataFrame
    obd_speed: pd.DataFrame
    obd_rpm: pd.DataFrame
    gnss: pd.DataFrame
    imu: pd.DataFrame
    gyro_raw: pd.DataFrame
    accel_raw: pd.DataFrame
    engine: pd.DataFrame
    trip_events: pd.DataFrame
    link_stats: pd.DataFrame
    time_sync: pd.DataFrame
    transcript: pd.DataFrame
    dropouts_ms: list[int] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        ends = [df["t_s"].max() for df in (self.imu, self.gnss, self.obd) if len(df)]
        return float(max(ends)) if ends else 0.0

    @property
    def complete(self) -> bool:
        return bool(len(self.trip_events)) and bool((self.trip_events["event"] == "end").any())

    def to_utc(self, t_s) -> pd.Series | pd.Timestamp:
        """Map log seconds to UTC using the nearest preceding time_sync record."""
        if len(self.time_sync) == 0:
            raise ValueError("log has no time_sync records")
        ts = self.time_sync
        idx = np.searchsorted(ts["t_s"].to_numpy(), np.atleast_1d(t_s), side="right") - 1
        idx = np.clip(idx, 0, len(ts) - 1)
        offset = ts["utc_us"].to_numpy()[idx] - (ts["t_s"].to_numpy()[idx] * 1e6)
        utc_us = np.atleast_1d(t_s) * 1e6 + offset
        out = pd.to_datetime(utc_us.astype("int64"), unit="us", utc=True)
        return out[0] if np.isscalar(t_s) else pd.Series(out)

    def streams(self) -> dict[str, pd.DataFrame]:
        return {
            "obd": self.obd,
            "obd_speed": self.obd_speed,
            "obd_rpm": self.obd_rpm,
            "gnss": self.gnss,
            "imu": self.imu,
            "gyro_raw": self.gyro_raw,
            "accel_raw": self.accel_raw,
            "engine": self.engine,
            "trip_events": self.trip_events,
            "link_stats": self.link_stats,
            "time_sync": self.time_sync,
            "transcript": self.transcript,
        }


def _dataset(ulog: ULog, name: str) -> dict[str, np.ndarray] | None:
    try:
        return ulog.get_dataset(name).data
    except (KeyError, IndexError, ValueError):
        return None


def _t(start_us: int, timestamps: np.ndarray) -> np.ndarray:
    return (timestamps.astype("float64") - start_us) / 1e6


def _vec(d: dict, base: str, n: int) -> list[np.ndarray]:
    return [d[f"{base}[{i}]"] for i in range(n)]


def load(path: str | Path) -> Trip:
    path = Path(path)
    ulog = ULog(str(path))
    start = int(ulog.start_timestamp)
    info = dict(ulog.msg_info_dict)
    version = info.get("wtf_log_ver")
    if version not in SUPPORTED_LOG_VERSIONS:
        raise ValueError(f"unsupported wtf_log_ver {version!r} (reader supports {SUPPORTED_LOG_VERSIONS})")

    # --- OBD ---
    d = _dataset(ulog, "obd_pid")
    if d is not None:
        data = np.stack(_vec(d, "data", 4), axis=1)
        obd = pd.DataFrame(
            {
                "t_rx_s": _t(start, d["timestamp"]),
                "latency_ms": d["latency_us"] / 1000.0,
                "mode": d["mode"],
                "pid": d["pid"],
                "status": [_name(OBD_STATUS, int(s)) for s in d["status"]],
                "n_bytes": d["n_bytes"],
                "b0": data[:, 0],
                "b1": data[:, 1],
                "b2": data[:, 2],
                "b3": data[:, 3],
                "ecu": d["ecu"],
                "value": d["value"].astype("float64"),
            }
        )
        # Sample time = midpoint of tx and rx (SPEC §3.1).
        obd.insert(0, "t_s", obd["t_rx_s"] - obd["latency_ms"] / 2000.0)
    else:
        obd = pd.DataFrame(columns=["t_s", "t_rx_s", "latency_ms", "mode", "pid", "status", "n_bytes", "b0", "b1", "b2", "b3", "ecu", "value"])

    sp = obd[(obd["mode"] == 1) & (obd["pid"] == PID_SPEED)] if len(obd) else obd
    obd_speed = pd.DataFrame(
        {
            "t_s": sp["t_s"],
            "speed_mps": sp["value"],
            "raw_kph": np.where(sp["status"] == "ok", sp["b0"], np.nan) if len(sp) else [],
            "latency_ms": sp["latency_ms"],
            "status": sp["status"],
            "ecu": sp["ecu"],
        }
    ).reset_index(drop=True)
    rp = obd[(obd["mode"] == 1) & (obd["pid"] == PID_RPM)] if len(obd) else obd
    obd_rpm = pd.DataFrame(
        {"t_s": rp["t_s"], "rpm": rp["value"], "latency_ms": rp["latency_ms"], "status": rp["status"]}
    ).reset_index(drop=True)

    # --- GNSS ---
    d = _dataset(ulog, "gnss")
    if d is not None:
        gnss = pd.DataFrame(
            {
                "t_s": _t(start, d["timestamp"]),
                "utc": pd.to_datetime(d["utc_us"].astype("int64"), unit="us", utc=True),
                "lat": d["lat_deg"],
                "lon": d["lon_deg"],
                "alt": d["alt_msl_m"].astype("float64"),
                "alt_ellipsoid": d["alt_ellipsoid_m"].astype("float64"),
                "h_acc": d["h_acc_m"].astype("float64"),
                "v_acc": d["v_acc_m"].astype("float64"),
                "speed": d["speed_mps"].astype("float64"),
                "speed_acc": d["speed_acc_mps"].astype("float64"),
                "course": d["course_rad"].astype("float64"),
                "course_acc": d["course_acc_rad"].astype("float64"),
                "delivery_delay_ms": d["delivery_delay_us"] / 1000.0,
                "simulated": (d["flags"] & 1).astype(bool),
                "from_accessory": (d["flags"] & 2).astype(bool),
            }
        )
    else:
        gnss = pd.DataFrame(columns=["t_s", "utc", "lat", "lon", "alt", "alt_ellipsoid", "h_acc", "v_acc", "speed", "speed_acc", "course", "course_acc", "delivery_delay_ms", "simulated", "from_accessory"])

    # --- IMU ---
    d = _dataset(ulog, "imu_motion")
    if d is not None:
        gx, gy, gz = (v.astype("float64") for v in _vec(d, "gyro_rad_s", 3))
        ax, ay, az = (v.astype("float64") for v in _vec(d, "user_accel_m_s2", 3))
        rx, ry, rz = (v.astype("float64") for v in _vec(d, "gravity_m_s2", 3))
        qw, qx, qy, qz = (v.astype("float64") for v in _vec(d, "attitude_q", 4))
        gnorm = np.sqrt(rx**2 + ry**2 + rz**2)
        with np.errstate(invalid="ignore", divide="ignore"):
            # Rotation rate about the local "up" axis: positive = counter-clockwise seen from above (left turn).
            yaw_up = -(gx * rx + gy * ry + gz * rz) / gnorm
        imu = pd.DataFrame(
            {
                "t_s": _t(start, d["timestamp"]),
                "gyro_x": gx, "gyro_y": gy, "gyro_z": gz,
                "ua_x": ax, "ua_y": ay, "ua_z": az,
                "g_x": rx, "g_y": ry, "g_z": rz,
                "q_w": qw, "q_x": qx, "q_y": qy, "q_z": qz,
                "yaw_rate_up": yaw_up,
            }
        )
    else:
        imu = pd.DataFrame(columns=["t_s", "gyro_x", "gyro_y", "gyro_z", "ua_x", "ua_y", "ua_z", "g_x", "g_y", "g_z", "q_w", "q_x", "q_y", "q_z", "yaw_rate_up"])

    def vec3(name: str, base: str, prefix: str) -> pd.DataFrame:
        dd = _dataset(ulog, name)
        if dd is None:
            return pd.DataFrame(columns=["t_s", f"{prefix}_x", f"{prefix}_y", f"{prefix}_z"])
        x, y, z = (v.astype("float64") for v in _vec(dd, base, 3))
        return pd.DataFrame({"t_s": _t(start, dd["timestamp"]), f"{prefix}_x": x, f"{prefix}_y": y, f"{prefix}_z": z})

    gyro_raw = vec3("gyro_raw", "gyro_rad_s", "gyro")
    accel_raw = vec3("accel_raw", "accel_m_s2", "accel")

    # --- events ---
    d = _dataset(ulog, "engine_state")
    engine = (
        pd.DataFrame({"t_s": _t(start, d["timestamp"]), "state": [_name(ENGINE_STATES, int(s)) for s in d["state"]]})
        if d is not None
        else pd.DataFrame(columns=["t_s", "state"])
    )
    d = _dataset(ulog, "trip_event")
    if d is not None:
        events = [_name(TRIP_EVENTS, int(e)) for e in d["event"]]
        trip_events = pd.DataFrame(
            {
                "t_s": _t(start, d["timestamp"]),
                "event": events,
                "reason": [_name(END_REASONS, int(r)) if e == "end" else "" for e, r in zip(events, d["reason"])],
            }
        )
    else:
        trip_events = pd.DataFrame(columns=["t_s", "event", "reason"])
    d = _dataset(ulog, "link_stats")
    link_stats = (
        pd.DataFrame(
            {
                "t_s": _t(start, d["timestamp"]),
                "speed_hz": d["speed_hz"].astype("float64"),
                "latency_p50_ms": d["latency_p50_ms"].astype("float64"),
                "latency_p95_ms": d["latency_p95_ms"].astype("float64"),
                "errors": d["errors"],
                "link_state": [_name(LINK_STATES, int(s)) for s in d["link_state"]],
                "battery_v": d["battery_v"].astype("float64"),
            }
        )
        if d is not None
        else pd.DataFrame(columns=["t_s", "speed_hz", "latency_p50_ms", "latency_p95_ms", "errors", "link_state", "battery_v"])
    )
    d = _dataset(ulog, "time_sync")
    time_sync = (
        pd.DataFrame({"t_s": _t(start, d["timestamp"]), "utc_us": d["utc_us"].astype("int64")})
        if d is not None
        else pd.DataFrame(columns=["t_s", "utc_us"])
    )

    rows = []
    for tag, messages in getattr(ulog, "logged_messages_tagged", {}).items():
        for m in messages:
            rows.append(
                {
                    "t_s": (m.timestamp - start) / 1e6,
                    "level": LOG_LEVELS.get(m.log_level, str(m.log_level)),
                    "tag": LOG_TAGS.get(tag, str(tag)),
                    "text": m.message,
                }
            )
    for m in ulog.logged_messages:
        rows.append({"t_s": (m.timestamp - start) / 1e6, "level": LOG_LEVELS.get(m.log_level, str(m.log_level)), "tag": "", "text": m.message})
    transcript = pd.DataFrame(rows, columns=["t_s", "level", "tag", "text"]).sort_values("t_s", kind="stable").reset_index(drop=True)

    dropouts = [int(x.duration) for x in ulog.dropouts]

    return Trip(
        path=path,
        start_us=start,
        info=info,
        obd=obd,
        obd_speed=obd_speed,
        obd_rpm=obd_rpm,
        gnss=gnss,
        imu=imu,
        gyro_raw=gyro_raw,
        accel_raw=accel_raw,
        engine=engine,
        trip_events=trip_events,
        link_stats=link_stats,
        time_sync=time_sync,
        transcript=transcript,
        dropouts_ms=dropouts,
    )
