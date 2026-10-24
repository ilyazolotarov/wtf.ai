import { orientPoint, parseCoordinates } from "@/nav/search/coordinates";

const at = (text: string) => {
  const p = parseCoordinates(text);
  return p && { lat: Number(p.lat.toFixed(5)), lon: Number(p.lon.toFixed(5)), ordered: p.ordered };
};

describe("parseCoordinates", () => {
  it("reads decimal degrees as Google Maps copies them", () => {
    expect(at("50.45012, 30.52341")).toEqual({ lat: 50.45012, lon: 30.52341, ordered: false });
    expect(at("  50.45012,30.52341 ")).toEqual({ lat: 50.45012, lon: 30.52341, ordered: false });
    expect(at("50.45012 30.52341")).toEqual({ lat: 50.45012, lon: 30.52341, ordered: false });
    expect(at("(50.45012; 30.52341)")).toEqual({ lat: 50.45012, lon: 30.52341, ordered: false });
    expect(at("-33.8568, 151.2153")).toEqual({ lat: -33.8568, lon: 151.2153, ordered: false });
  });

  it("reads decimal commas", () => {
    expect(at("50,45012 30,52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("50,45012; 30,52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("50,45012, 30,52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
  });

  it("reads degrees, minutes and seconds with hemisphere letters", () => {
    expect(at(`50°27'00.4"N 30°31'24.2"E`)).toEqual({ lat: 50.45011, lon: 30.52339, ordered: true });
    expect(at("50°27′00.4″N 30°31′24.2″E")).toMatchObject({ lat: 50.45011, lon: 30.52339 });
    expect(at("50°27.006'N 30°31.403'E")).toMatchObject({ lat: 50.4501, lon: 30.52338 });
    expect(at("50.45012° N, 30.52341° E")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("N50.45012 E30.52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("n 50.45012, e 30.52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("50.45012N30.52341E")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("30.52341E 50.45012N")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at(`33°51'24.5"S 151°12'55.1"E`)).toMatchObject({ lat: -33.85681, lon: 151.21531 });
    expect(at("40.7° N, 74.0° W")).toMatchObject({ lat: 40.7, lon: -74 });
  });

  it("reads map links", () => {
    expect(at("https://www.google.com/maps/place/50%C2%B027'00.4%22N+30%C2%B031'24.2%22E/@50.4501,30.5208,17z/data=!3m1!4b1!4m4!3m3!8m2!3d50.45012!4d30.52341")).toEqual({
      lat: 50.45012,
      lon: 30.52341,
      ordered: true,
    });
    expect(at("https://www.google.com/maps/@50.4501,30.5208,17z")).toMatchObject({ lat: 50.4501, lon: 30.5208 });
    expect(at("https://www.google.com/maps/search/?api=1&query=50.45012%2C30.52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("https://maps.google.com/?q=50.45012,30.52341")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("https://maps.apple.com/?ll=50.45012,30.52341&q=Pin")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("https://www.openstreetmap.org/?mlat=50.45012&mlon=30.52341#map=17/50.4501/30.5208")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("https://www.openstreetmap.org/#map=17/50.4501/30.5208")).toMatchObject({ lat: 50.4501, lon: 30.5208 });
    expect(at("geo:50.45012,30.52341?z=17")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
    expect(at("lat: 50.45012, lon: 30.52341")).toMatchObject({ lat: 50.45012, lon: 30.52341, ordered: true });
    expect(at("lng=30.52341 lat=50.45012")).toMatchObject({ lat: 50.45012, lon: 30.52341 });
  });

  it("puts a first number past 90 as the longitude", () => {
    expect(at("151.2153, -33.8568")).toEqual({ lat: -33.8568, lon: 151.2153, ordered: true });
  });

  it("leaves addresses, short links and nonsense alone", () => {
    for (const text of [
      "",
      "Шевченка 10",
      "Оболонський 16 3",
      "16 3",
      "50, 30",
      "10/2",
      "50.45",
      "50.45, 30.52, 12.1",
      "50.4530.52",
      "95.1, 200.2",
      "50.45 N 30.52 N",
      "N50.45 30.52",
      `50.5°30'N 30°E`,
      "50°61'N 30°E",
      "https://maps.app.goo.gl/abcdEF12",
      "Nord 50.45 30.52",
    ]) {
      expect([text, parseCoordinates(text)]).toEqual([text, null]);
    }
  });
});

describe("orientPoint", () => {
  const ukraine = (c: { lat: number; lon: number }) => c.lat > 44 && c.lat < 53 && c.lon > 22 && c.lon < 41;

  it("swaps a bare pair only when that alone lands in the region", () => {
    expect(orientPoint({ lat: 30.52, lon: 50.45, ordered: false }, ukraine)).toEqual({ lat: 50.45, lon: 30.52 });
    expect(orientPoint({ lat: 50.45, lon: 30.52, ordered: false }, ukraine)).toEqual({ lat: 50.45, lon: 30.52 });
    expect(orientPoint({ lat: 30.52, lon: 50.45, ordered: true }, ukraine)).toEqual({ lat: 30.52, lon: 50.45 });
    expect(orientPoint({ lat: 10, lon: 10, ordered: false }, ukraine)).toEqual({ lat: 10, lon: 10 });
  });
});
