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

export type CalibrationStatus = "not-calibrated" | "calibrating" | "calibrated" | "skipped";

export const calibrationMock: { status: CalibrationStatus; steps: number } = {
  status: "not-calibrated",
  steps: 3,
};

export type PackStatus = "not-downloaded" | "downloading" | "ready";

export const downloadsMock: {
  id: "map" | "routing";
  size: string;
  version: string;
  status: PackStatus;
}[] = [
  { id: "map", size: "1.2 GB", version: "2026.09", status: "not-downloaded" },
  { id: "routing", size: "840 MB", version: "2026.09", status: "not-downloaded" },
];

export const ekfMock = {
  eastM: null,
  northM: null,
  headingRad: null,
  speedMps: null,
  speedScale: null,
  yawBias: null,
  yawScale: null,
} as const;
