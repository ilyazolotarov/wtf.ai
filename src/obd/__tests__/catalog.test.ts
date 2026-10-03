import { compareDevices, normalizeUuid, rankDevice, selectUartCandidates } from "@/obd/catalog";

describe("rankDevice", () => {
  test("advertised known service wins", () => {
    expect(rankDevice({ name: null, serviceUuids: ["0000fff0-0000-1000-8000-00805f9b34fb"] })).toMatchObject({
      rank: "known-profile",
      profileId: "fff0",
    });
  });

  test("brand and generic names", () => {
    expect(rankDevice({ name: "vLinker MC-IOS" })).toEqual({ rank: "known-name", brandHint: "Vgate" });
    expect(rankDevice({ name: "OBDII" })).toEqual({ rank: "known-name", brandHint: "Generic ELM327" });
    expect(rankDevice({ name: "AirPods Pro" })).toEqual({ rank: "unknown" });
    expect(rankDevice({ name: "BlueDriver" }).rank).toBe("non-elm");
  });

  test("ordering: rank, then RSSI", () => {
    const list = [
      { rank: "unknown" as const, rssi: -40, name: "x" },
      { rank: "known-name" as const, rssi: -80, name: "OBDII" },
      { rank: "known-name" as const, rssi: -50, name: "OBD2" },
      { rank: "remembered" as const, name: "mine" },
    ].sort(compareDevices);
    expect(list.map((d) => d.name)).toEqual(["mine", "OBD2", "OBDII", "x"]);
  });
});

describe("selectUartCandidates", () => {
  test("uuid normalization", () => {
    expect(normalizeUuid("0000ffe1-0000-1000-8000-00805f9b34fb")).toBe("FFE1");
  });

  test("catalog profile, ignoring Device Information", () => {
    const c = selectUartCandidates([
      { uuid: "180A", characteristics: [{ uuid: "2A29", properties: ["read"] }] },
      {
        uuid: "FFF0",
        characteristics: [
          { uuid: "FFF1", properties: ["notify"] },
          { uuid: "FFF2", properties: ["write", "writeWithoutResponse"] },
        ],
      },
    ]);
    expect(c).toEqual([{ profileId: "fff0", service: "FFF0", notify: "FFF1", write: "FFF2" }]);
  });

  test("ISSC picks characteristics by properties", () => {
    const c = selectUartCandidates([
      {
        uuid: "49535343-FE7D-4AE5-8FA9-9FAFD205E455",
        characteristics: [
          { uuid: "49535343-1E4D-4BD9-BA61-23C647249616", properties: ["notify"] },
          { uuid: "49535343-8841-43F4-A8D4-ECBE34729BB3", properties: ["writeWithoutResponse"] },
        ],
      },
    ]);
    expect(c[0].profileId).toBe("issc");
  });

  test("heuristic for unknown vendor service, skips ambiguous ones", () => {
    const c = selectUartCandidates([
      {
        uuid: "12345678-0000-0000-0000-000000000001",
        characteristics: [
          { uuid: "A1", properties: ["notify"] },
          { uuid: "A2", properties: ["write"] },
        ],
      },
      {
        uuid: "12345678-0000-0000-0000-000000000002",
        characteristics: [
          { uuid: "B1", properties: ["notify"] },
          { uuid: "B2", properties: ["notify"] },
          { uuid: "B3", properties: ["write"] },
        ],
      },
      { uuid: "1812", characteristics: [{ uuid: "2A4D", properties: ["notify", "write"] }] },
    ]);
    expect(c).toEqual([
      { profileId: "heuristic", service: "12345678-0000-0000-0000-000000000001", notify: "A1", write: "A2" },
    ]);
  });
});
