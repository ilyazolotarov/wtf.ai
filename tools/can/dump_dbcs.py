"""Prints every opendbc DBC as JSON {name: text}: the plain files and the ones opendbc generates from templates.

Run by tools/can/profiles.ts. Loads only opendbc's DBC generator (plain Python), not the opendbc package.
"""

import importlib.util
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opendbc")
sys.path.insert(0, ROOT)
DBC_DIR = os.path.join(ROOT, "opendbc", "dbc")

spec = importlib.util.spec_from_file_location("dbc_generator", os.path.join(DBC_DIR, "generator", "generator.py"))
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)

dbcs = dict(generator.generate_all())
for name in os.listdir(DBC_DIR):
    if name.endswith(".dbc"):
        with open(os.path.join(DBC_DIR, name), encoding="utf-8") as f:
            dbcs[name[:-4]] = f.read()

sys.stdout.write(json.dumps(dbcs))
