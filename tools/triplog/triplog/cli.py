"""Command line: triplog info|export|plot|check|refresh."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .analysis import check, estimate_refresh, summary
from .reader import load


def _info(args) -> int:
    for f in args.files:
        print(json.dumps(summary(load(f)), indent=2, default=str))
    return 0


def _export(args) -> int:
    trip = load(args.file)
    out = Path(args.out or Path(args.file).with_suffix(""))
    out.mkdir(parents=True, exist_ok=True)
    for name, df in trip.streams().items():
        if len(df) == 0:
            continue
        if args.parquet:
            df.to_parquet(out / f"{name}.parquet", index=False)
        else:
            df.to_csv(out / f"{name}.csv", index=False)
    (out / "info.json").write_text(json.dumps(trip.info, indent=2, default=str))
    print(f"exported to {out}")
    return 0


def _plot(args) -> int:
    from .plot import plot_trip

    plot_trip(load(args.file), args.out)
    if args.out:
        print(f"saved {args.out}")
    return 0


def _check(args) -> int:
    worst = 0
    for f in args.files:
        print(f"== {f}")
        for finding in check(load(f)):
            print(f"  [{finding.level.upper():4}] {finding.message}")
            worst = max(worst, {"ok": 0, "warn": 1, "fail": 2}[finding.level])
    return 2 if worst == 2 else 0


def _refresh(args) -> int:
    est = estimate_refresh([load(f) for f in args.files])
    print(json.dumps(est.__dict__, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="triplog", description="wtf.ai trip log tools")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("info", help="summary of one or more logs")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=_info)

    s = sub.add_parser("export", help="one CSV/Parquet file per stream")
    s.add_argument("file")
    s.add_argument("out", nargs="?")
    fmt = s.add_mutually_exclusive_group()
    fmt.add_argument("--csv", action="store_true", default=True)
    fmt.add_argument("--parquet", action="store_true")
    s.set_defaults(fn=_export)

    s = sub.add_parser("plot", help="quick-look plots")
    s.add_argument("file")
    s.add_argument("-o", "--out", help="save PNG instead of showing a window")
    s.set_defaults(fn=_plot)

    s = sub.add_parser("check", help="sanity checks (exit 2 on failures)")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=_check)

    s = sub.add_parser("refresh", help="estimate the ECU refresh period of PID 0D")
    s.add_argument("files", nargs="+")
    s.set_defaults(fn=_refresh)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
