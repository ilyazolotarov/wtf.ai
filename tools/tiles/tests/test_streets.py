import osmium

from tiles.streets import house_street_changes

# A way and a node listed in an associatedStreet relation with a number only, one with its own
# addr:street, one with addr:place, a house in no relation, and the relation's street way.
OSM = """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
<node id="1" version="1" lat="51.49" lon="31.29"/>
<node id="2" version="1" lat="51.49" lon="31.30"/>
<node id="3" version="1" lat="51.4902" lon="31.2902"/>
<node id="10" version="3" lat="51.4903" lon="31.2903"><tag k="addr:housenumber" v="26"/></node>
<node id="11" version="1" lat="51.4904" lon="31.2904"><tag k="addr:housenumber" v="5"/><tag k="addr:street" v="вулиця Нова"/></node>
<node id="12" version="1" lat="51.4905" lon="31.2905"><tag k="addr:housenumber" v="7"/><tag k="addr:place" v="Іванівка"/></node>
<node id="13" version="1" lat="51.4906" lon="31.2906"><tag k="addr:housenumber" v="99"/></node>
<way id="101" version="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="secondary"/><tag k="name" v="проспект Миру"/></way>
<way id="110" version="2"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="building" v="apartments"/><tag k="addr:housenumber" v="28"/></way>
<relation id="1" version="1">
  <member type="way" ref="101" role="street"/><member type="way" ref="110" role="house"/>
  <member type="node" ref="10" role=""/><member type="node" ref="11" role="house"/><member type="node" ref="12" role="house"/>
  <tag k="type" v="associatedStreet"/><tag k="name" v="проспект Миру"/>
</relation>
</osm>
"""


def test_houses_get_their_place_or_relation_street(tmp_path):
    src = tmp_path / "in.osm"
    src.write_text(OSM, encoding="utf-8")
    out = tmp_path / "streets.osc"
    assert house_street_changes(src, out) == 3
    changed = {(o.type_str(), o.id): (dict(o.tags), o.version, [n.ref for n in o.nodes] if o.is_way() else None)
               for o in osmium.FileProcessor(str(out))}
    assert changed == {
        ("n", 10): ({"addr:housenumber": "26", "addr:street": "проспект Миру"}, 4, None),
        ("w", 110): ({"building": "apartments", "addr:housenumber": "28", "addr:street": "проспект Миру"}, 3, [1, 2, 3, 1]),
        # addressed by its place (a quarter, a village): the place, also when a relation lists it
        ("n", 12): ({"addr:housenumber": "7", "addr:place": "Іванівка", "addr:street": "Іванівка"}, 2, None),
    }
