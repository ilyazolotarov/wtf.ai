import { addressQueries, geoSearchText, parseGeoUri } from "../geo-uri";

describe("parseGeoUri", () => {
  it("reads a point", () => {
    expect(parseGeoUri("geo:50.45012,30.52341")).toEqual({ point: { lat: 50.45012, lon: 30.52341 }, query: null });
    expect(parseGeoUri("geo:50.45,30.52,170;u=35")).toEqual({ point: { lat: 50.45, lon: 30.52 }, query: null });
    expect(parseGeoUri("GEO:-33.9,151.2?z=17")).toEqual({ point: { lat: -33.9, lon: 151.2 }, query: null });
  });

  it("reads words to search for, as the car's assistant sends them", () => {
    expect(parseGeoUri("geo:0,0?q=Khreshchatyk+22")).toEqual({ point: null, query: "Khreshchatyk 22" });
    expect(parseGeoUri("geo:0,0?q=%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA%2022&mode=d&entry=assistant")).toEqual({
      point: null,
      query: "Хрещатик 22",
    });
  });

  it("keeps a point's name", () => {
    expect(parseGeoUri("geo:50.45,30.52?q=Maidan&intent=navigation")).toEqual({ point: { lat: 50.45, lon: 30.52 }, query: "Maidan" });
    expect(parseGeoUri("geo:0,0?q=50.45,30.52(Maidan Nezalezhnosti)")).toEqual({
      point: { lat: 50.45, lon: 30.52 },
      query: "Maidan Nezalezhnosti",
    });
    expect(parseGeoUri("geo:0,0?q=50.45%2C30.52")).toEqual({ point: { lat: 50.45, lon: 30.52 }, query: null });
  });

  it("reads Google Maps' navigation links", () => {
    expect(parseGeoUri("google.navigation:q=Lviv+Rynok+Square&mode=d")).toEqual({ point: null, query: "Lviv Rynok Square" });
    expect(parseGeoUri("google.navigation:q=49.84,24.03")).toEqual({ point: { lat: 49.84, lon: 24.03 }, query: null });
    expect(parseGeoUri("google.navigation:ll=49.84,24.03")).toEqual({ point: { lat: 49.84, lon: 24.03 }, query: null });
  });

  it("reads Waze's links: a taxi driver app's navigate button, or pasted from Waze's Share", () => {
    expect(parseGeoUri("waze://?ll=50.45012,30.52341&navigate=yes")).toEqual({ point: { lat: 50.45012, lon: 30.52341 }, query: null });
    expect(parseGeoUri("waze://?q=Khreshchatyk+22&navigate=yes")).toEqual({ point: null, query: "Khreshchatyk 22" });
    expect(parseGeoUri("https://www.waze.com/ul?ll=49.84%2C24.03&navigate=yes&zoom=17")).toEqual({
      point: { lat: 49.84, lon: 24.03 },
      query: null,
    });
    expect(parseGeoUri("https://ul.waze.com/ul?ll=49.84%2C24.03&q=Rynok+Square&utm_source=share")).toEqual({
      point: { lat: 49.84, lon: 24.03 },
      query: "Rynok Square",
    });
    expect(parseGeoUri("waze://?ll=0,0&navigate=yes")).toBeNull();
    expect(parseGeoUri("https://waze.com.evil.example/ul?ll=49.84,24.03")).toBeNull();
  });

  it("reads 2GIS's route links, longitude first", () => {
    expect(parseGeoUri("dgis://2gis.ru/routeSearch/rsType/car/to/30.52341,50.45012")).toEqual({
      point: { lat: 50.45012, lon: 30.52341 },
      query: null,
    });
    expect(parseGeoUri("dgis://2gis.ua/routeSearch/rsType/car/from/30.4,50.4/to/24.03,49.84")).toEqual({
      point: { lat: 49.84, lon: 24.03 },
      query: null,
    });
    expect(parseGeoUri("dgis://2gis.ru/routeSearch/rsType/car/to/")).toBeNull();
    expect(parseGeoUri("dgis://2gis.ru/routeSearch/rsType/car/to/200,50")).toBeNull();
  });

  it("reads Apple Maps' links, pasted from its Share button", () => {
    expect(
      parseGeoUri(
        "https://maps.apple.com/place?place-id=I1234ABCD&address=Khreshchatyk+St,+22,+Kyiv,+Ukraine,+02000&coordinate=50.447,30.522&name=Khreshchatyk+22&_provider=9902",
      ),
    ).toEqual({ point: { lat: 50.447, lon: 30.522 }, query: "Khreshchatyk 22" });
    expect(parseGeoUri("https://maps.apple.com/?address=Khreshchatyk%20St,%2022,%20Kyiv&auid=123&ll=50.447,30.522&lsp=9902&q=Passage")).toEqual({
      point: { lat: 50.447, lon: 30.522 },
      query: "Passage",
    });
    expect(parseGeoUri("http://maps.apple.com/?q=Maidan&ll=50.45,30.52")).toEqual({ point: { lat: 50.45, lon: 30.52 }, query: "Maidan" });
    expect(parseGeoUri("maps://?q=50.45,30.52")).toEqual({ point: { lat: 50.45, lon: 30.52 }, query: null });
  });

  it("searches an Apple Maps link without a point by its address, or else its words", () => {
    expect(parseGeoUri("https://maps.apple.com/place?address=Lesi+Ukrainky+Blvd,+26,+Kyiv&name=Office+Centre")).toEqual({
      point: null,
      query: "Lesi Ukrainky Blvd, 26, Kyiv",
    });
    expect(parseGeoUri("https://maps.apple.com/directions?destination=Lviv+Rynok+Square&mode=driving")).toEqual({
      point: null,
      query: "Lviv Rynok Square",
    });
    expect(parseGeoUri("https://maps.apple.com/directions?destination=49.84,24.03")).toEqual({ point: { lat: 49.84, lon: 24.03 }, query: null });
    expect(parseGeoUri("https://maps.apple.com/search?query=fuel")).toEqual({ point: null, query: "fuel" });
    expect(parseGeoUri("maps:?daddr=Khreshchatyk+22&sll=50.4,30.5")).toEqual({ point: null, query: "Khreshchatyk 22" });
  });

  it("is null for anything else, or a link that asks for nothing", () => {
    expect(parseGeoUri("https://maps.apple.com/place?place-id=I1234ABCD")).toBeNull();
    expect(parseGeoUri("https://maps.apple/p/abc123")).toBeNull();
    expect(parseGeoUri("https://maps.apple.com.evil.example/?q=x")).toBeNull();
    expect(parseGeoUri("https://maps.google.com/?q=50.45,30.52")).toBeNull();
    expect(parseGeoUri("wtfai://route")).toBeNull();
    expect(parseGeoUri("geo:0,0")).toBeNull();
    expect(parseGeoUri("geo:0,0?q=")).toBeNull();
    expect(parseGeoUri("geo:91,30")).toBeNull();
    expect(parseGeoUri("geo:0,0?q=%E0%A4%A")).toEqual({ point: null, query: "%E0%A4%A" });
  });
});

describe("geoSearchText", () => {
  it("gives the search field the point's coordinates or the words", () => {
    expect(geoSearchText("geo:50.45,30.52?q=Maidan")).toBe("50.450000, 30.520000");
    expect(geoSearchText("geo:0,0?q=Khreshchatyk+22")).toBe("Khreshchatyk 22");
    expect(geoSearchText("Khreshchatyk 22")).toBeNull();
    expect(geoSearchText("geo:0,0?q=Khreshchatyk+St,+22,+Kyiv,+Ukraine,+02000")).toBe("Khreshchatyk St, 22, Kyiv");
    expect(geoSearchText("https://maps.apple.com/place?address=Khreshchatyk+St,+22,+Kyiv,+Ukraine,+02000")).toBe("Khreshchatyk St, 22, Kyiv");
    expect(geoSearchText("https://maps.apple.com/place?coordinate=50.447,30.522&name=Passage")).toBe("50.447000, 30.522000");
  });
});

describe("addressQueries", () => {
  it("drops what the index doesn't hold from the assistant's address: country, postcode, oblast", () => {
    expect(addressQueries("Khreshchatyk St, 22, Kyiv, Ukraine, 02000")).toEqual(["Khreshchatyk St, 22, Kyiv", "Khreshchatyk St, Kyiv"]);
    expect(addressQueries("вулиця Хрещатик, 22, Київ, Київська область, Україна, 02000")).toEqual([
      "вулиця Хрещатик, 22, Київ",
      "вулиця Хрещатик, Київ",
    ]);
    expect(addressQueries("Maidan Nezalezhnosti, Kyiv, Ukraine")).toEqual(["Maidan Nezalezhnosti, Kyiv"]);
    expect(addressQueries("Google Building 41, 1600 Amphitheatre Parkway, Mountain View, CA 94043-1351, USA")).toEqual([
      "Google Building 41, 1600 Amphitheatre Parkway, Mountain View, USA",
    ]);
  });

  it("tries a place's address, then its name, when both found nothing together", () => {
    expect(addressQueries("Kyiv Pechersk Lavra, Lavrska St, 15, Kyiv, Ukraine, 01015")).toEqual([
      "Kyiv Pechersk Lavra, Lavrska St, 15, Kyiv",
      "Lavrska St, 15, Kyiv",
      "Kyiv Pechersk Lavra",
    ]);
  });

  it("leaves words the driver would type alone", () => {
    expect(addressQueries("Silpo")).toEqual(["Silpo"]);
    expect(addressQueries("Shevchenka 10")).toEqual(["Shevchenka 10"]);
  });
});
