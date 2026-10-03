// Buffered trip log writer (docs/TRIP-LOGGER-SPEC.md §6.6): encode in memory,
// flush to the sink every 1 s or 64 KB followed by a sync message.

import {
  ACCEL_RAW,
  ALL_FORMATS,
  ENGINE_STATE,
  GNSS,
  GYRO_RAW,
  IMU_MOTION,
  LINK_STATS,
  OBD_PID,
  TIME_SYNC,
  TRIP_EVENT,
  WTF_LOG_VERSION,
  type GnssRecord,
  type ImuMotionRecord,
  type LinkStatsRecord,
  type ObdPidRecord,
  type Vec3Record,
} from "./schema";
import { ULogEncoder } from "./ulog/encoder";
import { LOG_LEVEL } from "./ulog/format";

export interface ByteSink {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface TripLogMeta {
  startUs: number;
  utcUs: number;
  /** Extra info messages (TRIP-LOGGER-SPEC §6.2). Strings → char[], numbers → uint32. */
  info: Record<string, string | number>;
}

export interface WriterOptions {
  flushIntervalUs: number;
  flushBytes: number;
  /** Drop IMU data above this many unflushed bytes (sink stalled). */
  maxBufferBytes: number;
  timeSyncIntervalUs: number;
}

export const DEFAULT_WRITER_OPTIONS: WriterOptions = {
  flushIntervalUs: 1_000_000,
  flushBytes: 64 * 1024,
  maxBufferBytes: 1024 * 1024,
  timeSyncIntervalUs: 60_000_000,
};

export type LogLevel = keyof typeof LOG_LEVEL;

export class TripLogWriter {
  private enc: ULogEncoder;
  private opts: WriterOptions;
  private lastFlushUs: number;
  private lastTimeSyncUs: number;
  private droppedSinceUs: number | null = null;
  private closed = false;
  bytesWritten = 0;

  constructor(
    private readonly sink: ByteSink,
    meta: TripLogMeta,
    opts: Partial<WriterOptions> = {},
  ) {
    this.opts = { ...DEFAULT_WRITER_OPTIONS, ...opts };
    this.enc = new ULogEncoder(meta.startUs);
    this.enc.infoUint32("wtf_log_ver", WTF_LOG_VERSION);
    for (const [key, value] of Object.entries(meta.info)) {
      if (typeof value === "number") this.enc.infoUint32(key, value);
      else this.enc.infoString(key, value);
    }
    for (const f of ALL_FORMATS) this.enc.format(f);
    for (const f of ALL_FORMATS) this.enc.subscribe(f.name);
    this.enc.data(TIME_SYNC.name, [meta.startUs, meta.utcUs]);
    this.lastFlushUs = meta.startUs;
    this.lastTimeSyncUs = meta.startUs;
    this.flush();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  obd(r: ObdPidRecord): void {
    this.enc.data(OBD_PID.name, [
      r.timestampUs,
      r.latencyUs,
      r.mode,
      r.pid,
      r.status,
      r.data.length,
      r.data,
      r.ecu,
      r.value,
    ]);
  }

  gnss(r: GnssRecord): void {
    this.enc.data(GNSS.name, [
      r.timestampUs,
      r.utcUs,
      r.latDeg,
      r.lonDeg,
      r.altMslM,
      r.altEllipsoidM,
      r.hAccM,
      r.vAccM,
      r.speedMps,
      r.speedAccMps,
      r.courseRad,
      r.courseAccRad,
      r.deliveryDelayUs,
      r.flags,
    ]);
  }

  imuMotion(r: ImuMotionRecord): void {
    if (this.overBudget(r.timestampUs)) return;
    this.enc.data(IMU_MOTION.name, [r.timestampUs, r.gyro, r.userAccel, r.gravity, r.attitude]);
  }

  gyroRaw(r: Vec3Record): void {
    if (this.overBudget(r.timestampUs)) return;
    this.enc.data(GYRO_RAW.name, [r.timestampUs, r.v]);
  }

  accelRaw(r: Vec3Record): void {
    if (this.overBudget(r.timestampUs)) return;
    this.enc.data(ACCEL_RAW.name, [r.timestampUs, r.v]);
  }

  engineState(timestampUs: number, code: number): void {
    this.enc.data(ENGINE_STATE.name, [timestampUs, code]);
  }

  tripEvent(timestampUs: number, event: number, reason = 0): void {
    this.enc.data(TRIP_EVENT.name, [timestampUs, event, reason]);
  }

  linkStats(r: LinkStatsRecord): void {
    this.enc.data(LINK_STATS.name, [
      r.timestampUs,
      r.speedHz,
      r.latencyP50Ms,
      r.latencyP95Ms,
      Math.min(0xffff, r.errors),
      r.linkState,
      r.batteryV,
    ]);
  }

  timeSync(timestampUs: number, utcUs: number): void {
    this.enc.data(TIME_SYNC.name, [timestampUs, utcUs]);
    this.lastTimeSyncUs = timestampUs;
  }

  log(level: LogLevel, tag: number, timestampUs: number, text: string): void {
    this.enc.tagged(LOG_LEVEL[level], tag, timestampUs, text);
  }

  /** Call periodically (and after writes); flushes when due. */
  tick(nowUs: number, utcUs: number): void {
    if (this.closed) return;
    if (nowUs - this.lastTimeSyncUs >= this.opts.timeSyncIntervalUs) this.timeSync(nowUs, utcUs);
    if (nowUs - this.lastFlushUs >= this.opts.flushIntervalUs || this.enc.pendingBytes >= this.opts.flushBytes) {
      this.lastFlushUs = nowUs;
      this.flush();
    }
  }

  flush(): void {
    if (this.closed) return;
    if (this.enc.pendingBytes === 0) return;
    this.enc.sync();
    const bytes = this.enc.take();
    this.sink.write(bytes);
    this.bytesWritten += bytes.length;
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.sink.close();
  }

  private overBudget(timestampUs: number): boolean {
    if (this.enc.pendingBytes < this.opts.maxBufferBytes) {
      if (this.droppedSinceUs !== null) {
        this.enc.dropout((timestampUs - this.droppedSinceUs) / 1000);
        this.droppedSinceUs = null;
      }
      return false;
    }
    this.droppedSinceUs ??= timestampUs;
    return true;
  }
}
