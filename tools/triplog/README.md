# triplog — wtf.ai trip log reader

Reads the ULog trip logs written by the app (`Documents/trips/*.ulg`, schema in
[docs/TRIP-LOGGER-SPEC.md](../../docs/TRIP-LOGGER-SPEC.md) §6) into pandas DataFrames.

```bash
pip install -e tools/triplog            # add [parquet] for Parquet export, [dev] for pytest
triplog info  trip.ulg                  # duration, distance, stream rates, adapter, gaps
triplog check trip.ulg                  # sanity checks (exit 2 on failures)
triplog export trip.ulg out/ [--parquet]
triplog plot  trip.ulg [-o plot.png]    # OBD vs GNSS speed, yaw rate, track, poll latency
triplog refresh trip1.ulg trip2.ulg     # ECU refresh period of PID 0D → suggested speed cap
```

```python
from triplog import load
trip = load("20261003-081500_k3x9qa.ulg")
trip.obd_speed   # t_s (tx/rx midpoint), speed_mps, raw_kph, latency_ms, status
trip.gnss        # t_s, utc, lat, lon, h_acc, speed, speed_acc, course, …
trip.imu         # t_s, gyro_*, ua_*, g_*, q_*, yaw_rate_up (CCW+ seen from above)
trip.to_utc(trip.imu["t_s"])
```

`t_s` is seconds since log start on the phone's monotonic clock; all streams share it.
Logs also open directly in PlotJuggler and Foxglove.

Tests read `tests/data/fixture.ulg`, written by the TS writer
(`src/triplog/__fixtures__/trip-fixture.ts`; regenerate with `UPDATE_TRIPLOG_FIXTURE=1 npx jest src/triplog`):

```bash
cd tools/triplog && python -m pytest
```
