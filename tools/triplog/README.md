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
trip.mag         # t_s, mag_x/y/z: raw magnetic field, µT, phone frame (uncalibrated)
trip.to_utc(trip.imu["t_s"])
```

`t_s` is seconds since log start on the phone's monotonic clock; all streams share it.
Logs also open directly in PlotJuggler and Foxglove.

Put real trip logs pulled from the phone in `tools/triplog/logs/`. It is git-ignored,
because the logs hold the VIN and GPS tracks.

The folder (logs, drawn ground truth, regress baselines) is backed up to a private
S3-compatible bucket (Cloudflare R2). Never make the bucket public. `.env.local` at the repo
root holds its endpoint, bucket name and an access key with read & write on it; the names are
in `.env.example`.

```bash
npm run logs:status   # what differs, changes nothing
npm run logs:push     # after pulling new logs from the phone or drawing ground truth
npm run logs:pull     # on another PC, or to get back what was lost
```

Nothing is deleted on either side. A file is replaced only where it is unchanged since the
last sync; changed on both sides, it is reported as a conflict and left alone. A replaced
remote file is kept under `logs/history/` in the bucket.

Testers send logs from the app (More → Trip recorder → upload code, TRIP-LOGGER-SPEC §7.1) with
a code from you; `logs:pull` brings them into `logs/testers/<name>/`.

```bash
npm run testers:add -- tester-a       # prints their code once, e.g. bakim-tuvod-segap
npm run testers:add -- me --owner   # your own phone: its logs land next to the others
npm run testers:list
npm run testers:remove -- tester-a    # their code stops working; their logs stay
```

The upload Worker is in `workers/triplog-upload`. Deploying needs a Cloudflare login with only
these scopes, once per deploy:

```bash
npx wrangler login --scopes account:read user:read workers_scripts:write
npm run upload-worker:deploy
```

Tests read `tests/data/fixture.ulg`, written by the TS writer
(`src/triplog/__fixtures__/trip-fixture.ts`; regenerate with `UPDATE_TRIPLOG_FIXTURE=1 npx jest src/triplog`):

```bash
cd tools/triplog && python -m pytest
```
