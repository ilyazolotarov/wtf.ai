from __future__ import annotations

import argparse
import functools
import http.server
import tarfile

from .build import OUT, REGIONS, build_map
from .region import write_region


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tiles", description="wtf.ai offline map data")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("region", help="write regions/<name>.poly from an OSM boundary relation")
    p.add_argument("name")
    p.add_argument("relation", type=int)
    p.add_argument("--buffer-m", type=float, default=3000)

    p = sub.add_parser("build-map", help="build out/<region>/ (PMTiles, style, glyphs, sprites, manifest)")
    p.add_argument("region")
    p.add_argument("--refresh-osm", action="store_true", help="re-download the Ukraine extract")
    p.add_argument("--heap", default="4g", help="Java heap for Planetiler")
    p.add_argument("--skip-tiles", action="store_true", help="reuse existing map.pmtiles")

    p = sub.add_parser("pack", help="archive out/<region>/ as out/<region>.tar.gz for a GitHub release")
    p.add_argument("region")

    p = sub.add_parser("serve", help="serve out/ over HTTP for the app's dev pack install")
    p.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(argv)
    if args.cmd == "region":
        print(write_region(args.name, args.relation, REGIONS, buffer_m=args.buffer_m))
    elif args.cmd == "build-map":
        build_map(args.region, refresh_osm=args.refresh_osm, heap=args.heap, skip_tiles=args.skip_tiles)
    elif args.cmd == "pack":
        archive = OUT / f"{args.region}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(OUT / args.region, arcname=args.region)
        print(archive)
    elif args.cmd == "serve":
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
        print(f"Serving {OUT} on http://0.0.0.0:{args.port}/")
        http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
