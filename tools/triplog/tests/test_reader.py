"""Reads the golden fixture written by the TS writer (src/triplog/__fixtures__/trip-fixture.ts).
Values here must match that builder."""

from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from triplog import load
from triplog.analysis import check, estimate_refresh, summary
from triplog.cli import main

FIXTURE = Path(__file__).parent / "data" / "fixture.ulg"


@pytest.fixture(scope="module")
def trip():
    return load(FIXTURE)


def test_info(trip):
    assert trip.info["wtf_log_ver"] == 1
    assert trip.info["vehicle_vin"] == "JM3KFBDM1J0123456"
    assert trip.info["imu_frame"] == "xArbitraryZVertical"
    assert trip.start_us == 10_000_000


def test_obd(trip):
    sp = trip.obd_speed
    assert len(sp) == 10
    assert sp["status"].tolist().count("no-data") == 1
    ok = sp[sp["status"] == "ok"]
    assert ok["raw_kph"].tolist() == [0, 10, 20, 30, 40, 60, 70, 80, 90]
    # Midpoint: rx at 50 ms·(i+1), latency 40 ms → t = 0.05·(i+1) − 0.02
    assert sp["t_s"].iloc[0] == pytest.approx(0.03)
    assert ok["speed_mps"].iloc[3] == pytest.approx(30 / 3.6, rel=1e-6)
    assert np.isnan(sp[sp["status"] == "no-data"]["speed_mps"]).all()
    assert trip.obd_rpm["rpm"].tolist() == [1726]


def test_gnss(trip):
    g = trip.gnss
    assert len(g) == 3
    assert g["lat"].iloc[2] == pytest.approx(50.4502)
    assert g["speed"].tolist() == [10, 11, 12]
    assert g["delivery_delay_ms"].iloc[0] == 120
    assert g["utc"].iloc[0] == pd.Timestamp(1_791_000_000_000_000, unit="us", tz="UTC")


def test_imu(trip):
    imu = trip.imu
    assert len(imu) == 100
    # gravity points down (−z) with the phone flat; +z rotation = CCW seen from above.
    assert imu["yaw_rate_up"].iloc[0] == pytest.approx(0.1, rel=1e-6)
    assert imu["t_s"].diff().iloc[1:].round(6).unique().tolist() == [0.01]


def test_events_and_time(trip):
    assert trip.engine["state"].tolist() == ["engine-running"]
    assert trip.trip_events["event"].tolist() == ["start", "end"]
    assert trip.trip_events["reason"].iloc[1] == "ignition_off"
    assert trip.complete
    assert trip.to_utc(1.0) == pd.Timestamp(1_791_000_001_000_000, unit="us", tz="UTC")
    assert trip.transcript["tag"].tolist() == ["elm"]
    assert trip.link_stats["link_state"].tolist() == ["polling"]


def test_summary_and_check(trip):
    s = summary(trip)
    assert s["complete"] is True
    assert s["rates_hz"]["imu"] == pytest.approx(100, rel=0.01)
    findings = check(trip)
    assert not [f for f in findings if f.level == "fail"]


def test_cli(tmp_path, capsys):
    assert main(["info", str(FIXTURE)]) == 0
    assert '"trip_id": "abc123"' in capsys.readouterr().out
    assert main(["export", str(FIXTURE), str(tmp_path / "out")]) == 0
    assert (tmp_path / "out" / "imu.csv").exists()
    assert main(["check", str(FIXTURE)]) == 0
    assert main(["plot", str(FIXTURE), "-o", str(tmp_path / "plot.png")]) == 0
    assert (tmp_path / "plot.png").stat().st_size > 0


def test_refresh_estimate(trip):
    rng = np.random.default_rng(1)
    period = 0.1
    t_poll = np.cumsum(rng.uniform(0.035, 0.045, 6000))  # ~25 Hz for ~4 min
    true_kph = 50 + 40 * np.sin(2 * np.pi * t_poll / 40)  # accelerate/brake cycles
    last_update = np.floor((t_poll - 0.013) / period) * period + 0.013  # ECU grid with a phase offset
    reported = np.round(50 + 40 * np.sin(2 * np.pi * last_update / 40))
    sp = pd.DataFrame(
        {"t_s": t_poll, "speed_mps": reported / 3.6, "raw_kph": reported, "latency_ms": 40.0, "status": "ok", "ecu": 0x7E8}
    )
    del true_kph
    est = estimate_refresh([replace(trip, obd_speed=sp)])
    assert est.period_s == pytest.approx(period, abs=0.003)
    assert est.suggested_cap_hz == pytest.approx(20, abs=1)
