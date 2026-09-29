export const adapterMock = {
  model: "OBDLink MX+",
  transport: "external-accessory",
  status: "disconnected",
  elmVersion: null,
  obdProtocol: null,
  pollRateHz: null,
} as const;

export const vehicleMock = {
  vin: null,
  odometryStage: 1,
  obdSpeedKph: null,
  yawRateDegS: null,
  yawSource: "phone-gyro",
} as const;

export const calibrationMock = {
  status: "not-calibrated",
  steps: 3,
} as const;

export const downloadsMock = [
  { id: "map", size: "1.2 GB", version: "2026.09" },
  { id: "routing", size: "840 MB", version: "2026.09" },
] as const;

export const ekfMock = {
  eastM: null,
  northM: null,
  headingRad: null,
  speedMps: null,
  speedScale: null,
  yawBias: null,
  yawScale: null,
} as const;
