import {
  parseElmVersion,
  parseMode01,
  parseProtocolNumber,
  parseResponse,
  parseVin,
  parseVoltage,
} from "@/obd/elm327/parser";
import { decodeRpm, decodeSpeedMps, decodeSupportedPids } from "@/obd/pids";

describe("parseResponse", () => {
  test("strips echo, NULs, prompt and mixed line endings", () => {
    const r = parseResponse("010D", "\u0000010D\r\n41 0D 3C\r\n\r\n>");
    expect(r).toEqual({ status: "ok", lines: ["41 0D 3C"] });
  });

  test("drops SEARCHING noise", () => {
    expect(parseResponse("0100", "SEARCHING...\r41 00 BE 3E B8 11\r\r>").lines).toEqual(["41 00 BE 3E B8 11"]);
  });

  test.each([
    ["NO DATA", "no-data"],
    ["SEARCHING...\rUNABLE TO CONNECT", "unable-to-connect"],
    ["?", "unknown-command"],
    ["CAN ERROR", "bus-error"],
    ["BUS INIT: ...ERROR", "bus-error"],
    ["STOPPED", "stopped"],
    ["BUFFER FULL", "buffer-full"],
  ])("maps %s", (body, status) => {
    expect(parseResponse("010D", `${body}\r\r>`).status).toBe(status);
  });

  test("data plus an error line is still ok", () => {
    expect(parseResponse("010D", "41 0D 10\rNO DATA\r>").status).toBe("ok");
  });
});

describe("parseMode01", () => {
  test("headers off, spaces on/off, lowercase", () => {
    expect(parseMode01(["41 0D 3C"], 0x0d, 1)).toEqual([{ ecu: null, bytes: [0x3c] }]);
    expect(parseMode01(["410d3c"], 0x0d, 1)).toEqual([{ ecu: null, bytes: [0x3c] }]);
  });

  test("11-bit CAN headers, two ECUs", () => {
    const answers = parseMode01(["7E8 03 41 0D 3C", "7E9034 10D3C".replace(" ", "")], 0x0d, 1);
    expect(answers).toEqual([
      { ecu: 0x7e8, bytes: [0x3c] },
      { ecu: 0x7e9, bytes: [0x3c] },
    ]);
  });

  test("29-bit CAN header", () => {
    expect(parseMode01(["18DAF110 04 41 0C 1A F8"], 0x0c, 2)).toEqual([{ ecu: 0x18daf110, bytes: [0x1a, 0xf8] }]);
  });

  test("ISO 9141 header with trailing checksum", () => {
    expect(parseMode01(["48 6B 10 41 0D 32 A5"], 0x0d, 1)).toEqual([{ ecu: 0x10, bytes: [0x32] }]);
  });

  test("ignores unrelated lines", () => {
    expect(parseMode01(["OK", "41 0C 10 00"], 0x0d, 1)).toEqual([]);
  });
});

describe("other parsers", () => {
  test("VIN from CAN multi-frame", () => {
    const lines = ["014", "0: 49 02 01 4A 4D 33", "1: 4B 46 42 44 4D 31 4A", "2: 30 31 32 33 34 35 36"];
    expect(parseVin(lines)).toBe("JM3KFBDM1J0123456");
  });

  test("VIN from ISO line-per-frame", () => {
    const lines = [
      "49 02 01 00 00 00 4A",
      "49 02 02 4D 33 4B 46",
      "49 02 03 42 44 4D 31",
      "49 02 04 4A 30 31 32",
      "49 02 05 33 34 35 36",
    ];
    expect(parseVin(lines)).toBe("JM3KFBDM1J0123456");
  });

  test("version, voltage, protocol", () => {
    expect(parseElmVersion(["", "ELM327 v1.5"])).toBe("ELM327 v1.5");
    expect(parseElmVersion(["ELM327 v1.4b"])).toBe("ELM327 v1.4b");
    expect(parseVoltage(["12.6V"])).toBe(12.6);
    expect(parseProtocolNumber(["A6"])).toBe(6);
    expect(parseProtocolNumber(["7"])).toBe(7);
  });

  test("PID decoders", () => {
    expect(decodeSpeedMps([36])).toBeCloseTo(10);
    expect(decodeRpm([0x1a, 0xf8])).toBe(1726);
    expect(decodeSupportedPids(0, [0xbe, 0x3e, 0xb8, 0x11])).toEqual(
      expect.arrayContaining(["01", "03", "04", "05", "06", "07", "0C", "0D", "20"]),
    );
  });
});
