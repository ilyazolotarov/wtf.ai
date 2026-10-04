from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path

from .build import RELEASE, REGIONS, build_all, build_common, build_graphs, remote_osm_date, write_index
from .graph import read_graph, validate
from .region import write_regions


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tiles", description="wtf.ai offline map data")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("regions", help="(re)write regions/<slug>.poly from regions.json (all by default)")
    p.add_argument("names", nargs="*")
    p.add_argument("--buffer-m", type=float, default=500)

    p = sub.add_parser("build-all", help="build out/release/: ukraine, every region (or the given ones), index.json")
    p.add_argument("names", nargs="*")
    p.add_argument("--refresh-osm", action="store_true", help="re-download the Ukraine extract")
    p.add_argument("--heap", default="4g", help="Java heap for Planetiler")

    p = sub.add_parser("graph", help="build out/release/<region>.graph.bin (all regions by default) and refresh index.json")
    p.add_argument("names", nargs="*")
    p.add_argument("--refresh-osm", action="store_true")

    p = sub.add_parser("graph-check", help="validate graph files")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("build-region", help="build out/release/<region>.pmtiles + .graph.bin and refresh index.json")
    p.add_argument("region")
    p.add_argument("--refresh-osm", action="store_true")
    p.add_argument("--heap", default="4g")

    sub.add_parser("index", help="rewrite shared files and index.json in out/release/")
    sub.add_parser("osm-date", help="print the date of the current Geofabrik Ukraine extract")

    p = sub.add_parser("serve", help="serve out/release/ over HTTP (app: Downloads → catalog source)")
    p.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(argv)
    if args.cmd == "regions":
        for path in write_regions(REGIONS, args.names or None, buffer_m=args.buffer_m):
            print(path)
    elif args.cmd == "build-all":
        build_all(args.names or None, refresh_osm=args.refresh_osm, heap=args.heap)
    elif args.cmd == "graph":
        build_graphs(args.names or None, refresh_osm=args.refresh_osm)
    elif args.cmd == "graph-check":
        failed = False
        for path in args.paths:
            problems = validate(read_graph(Path(path)))
            print(f"{path}: {'ok' if not problems else f'{len(problems)} problems'}")
            for problem in problems[:20]:
                print(f"  {problem}")
            failed |= bool(problems)
        raise SystemExit(1 if failed else 0)
    elif args.cmd == "build-region":
        build_all([args.region], refresh_osm=args.refresh_osm, heap=args.heap)
    elif args.cmd == "index":
        write_index(build_common())
    elif args.cmd == "osm-date":
        print(remote_osm_date())
    elif args.cmd == "serve":
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(RELEASE))
        print(f"Serving {RELEASE} on http://0.0.0.0:{args.port}/")
        http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
