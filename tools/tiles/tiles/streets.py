"""Streets of houses with no `addr:street`, for Planetiler.

Planetiler's house-number layer keeps one label per (`addr:street`, number) in a tile: every house
without `addr:street` counts as one street, so of all its "22"s in a tile one kept its label. Two
kinds: whole districts give a house its street through a `type=associatedStreet` relation, and
towns built in quarters ("… квартал") and villages address by `addr:place`.
`house_street_changes` writes the relation's name, else the place, as `addr:street` onto those
houses in a change file, which `osmium apply-changes` merges into the extract Planetiler reads.
The search index reads the original tags (search.py: relations and `addr:place` of its own).
"""

from __future__ import annotations

from pathlib import Path

import osmium


def read_relation_streets(pbf: Path) -> dict[tuple[str, int], str]:
    """The street each member of an associatedStreet (or street) relation is on: the relation's
    name, by ("n" | "w", id). Roles vary ("house", "address", none), so every member gets it;
    only a house number without `addr:street` uses it."""
    streets: dict[tuple[str, int], str] = {}
    relations = osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(
        osmium.filter.TagFilter(("type", "associatedStreet"), ("type", "street")))
    for rel in relations:
        name = (rel.tags.get("name") or "").strip()
        if not name:
            continue
        for m in rel.members:
            if m.type in ("n", "w") and m.role != "street":
                streets.setdefault((m.type, m.ref), name)
    return streets


def house_street_changes(pbf: Path, output: Path) -> int:
    """An .osc change file giving every house with a number but no `addr:street` the street of its
    relation, else its `addr:place` (version + 1, so it replaces the original); returns how many."""
    streets = read_relation_streets(pbf)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    count = 0
    with osmium.SimpleWriter(str(output)) as writer:
        houses = osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_filter(
            osmium.filter.KeyFilter("addr:housenumber"))
        for obj in houses:
            tags = obj.tags
            if "addr:street" in tags:
                continue
            place = (tags.get("addr:place") or "").strip()
            street = place or streets.get((obj.type_str(), obj.id))
            if not street:
                continue
            changed = obj.replace(tags={**dict(tags), "addr:street": street}, version=obj.version + 1)
            if obj.is_node():
                writer.add_node(changed)
            else:
                writer.add_way(changed)
            count += 1
    return count
