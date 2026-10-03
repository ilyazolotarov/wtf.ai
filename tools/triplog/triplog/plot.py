"""Quick-look plots for a trip log."""

from __future__ import annotations

import numpy as np

from .reader import Trip


def plot_trip(trip: Trip, out: str | None = None):
    import matplotlib

    if out:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(14, 10))
    fig.suptitle(f"{trip.path.name} — {trip.duration_s / 60:.1f} min")

    ax = fig.add_subplot(2, 2, 1)
    ok = trip.obd_speed[trip.obd_speed["status"] == "ok"]
    ax.plot(ok["t_s"], ok["raw_kph"], ".", ms=2, label="OBD 0D")
    if len(trip.gnss):
        ax.plot(trip.gnss["t_s"], trip.gnss["speed"] * 3.6, "-", lw=1, label="GNSS")
    for _, e in trip.engine.iterrows():
        ax.axvline(e["t_s"], color="0.7", lw=0.5)
    ax.set_xlabel("t [s]")
    ax.set_ylabel("speed [km/h]")
    ax.legend()
    ax.grid(alpha=0.3)

    ax = fig.add_subplot(2, 2, 2)
    if len(trip.imu):
        ax.plot(trip.imu["t_s"], np.degrees(trip.imu["yaw_rate_up"]), lw=0.5)
    ax.set_xlabel("t [s]")
    ax.set_ylabel("yaw rate (up, CCW+) [deg/s]")
    ax.grid(alpha=0.3)

    ax = fig.add_subplot(2, 2, 3)
    if len(trip.gnss):
        sc = ax.scatter(trip.gnss["lon"], trip.gnss["lat"], c=trip.gnss["h_acc"], s=4, cmap="viridis_r")
        fig.colorbar(sc, ax=ax, label="horizontal accuracy [m]")
        ax.set_aspect(1 / np.cos(np.radians(trip.gnss["lat"].mean())))
    ax.set_xlabel("lon")
    ax.set_ylabel("lat")
    ax.grid(alpha=0.3)

    ax = fig.add_subplot(2, 2, 4)
    ax.plot(ok["t_s"], ok["latency_ms"], ".", ms=2, label="poll latency")
    if len(trip.link_stats):
        ax2 = ax.twinx()
        ax2.plot(trip.link_stats["t_s"], trip.link_stats["speed_hz"], "r-", lw=1, label="speed poll rate")
        ax2.set_ylabel("rate [Hz]", color="r")
    ax.set_xlabel("t [s]")
    ax.set_ylabel("latency [ms]")
    ax.grid(alpha=0.3)

    fig.tight_layout()
    if out:
        fig.savefig(out, dpi=120)
        plt.close(fig)
    else:
        plt.show()
    return fig
