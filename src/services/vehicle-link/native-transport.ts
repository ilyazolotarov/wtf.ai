import type { EventSubscription } from "expo-modules-core";

import VehicleLinkModule from "../../../modules/vehicle-link/src/VehicleLinkModule";
import { GATT_PROFILES } from "@/obd/catalog";
import { Emitter } from "@/obd/emitter";
import type { ConnectedInfo, RawExchange, Transport } from "@/obd/types";
import type { RememberedAdapter } from "@/obd/vehicle-link-core";

const FIRST_CONNECT_TIMEOUT_MS = 15000;
const LINK_ERRORS = new Set(["link-lost", "not-connected"]);

/** BLE / MFi (iOS) / Classic SPP (Android) transport over modules/vehicle-link. Only one is active at a time. */
export class NativeTransport implements Transport {
  readonly kind: "ble" | "mfi" | "spp";
  private linkLost = new Emitter<[string]>();
  private unsolicited = new Emitter<[string, number]>();
  private subscriptions: EventSubscription[] = [];
  private connectedOnce = false;
  private up = false;

  constructor(
    private readonly deviceId: string,
    kind: "ble" | "mfi" | "spp",
    private readonly remembered?: RememberedAdapter,
  ) {
    this.kind = kind;
  }

  async connect(options?: { wait?: boolean }): Promise<ConnectedInfo> {
    this.listen();
    const gatt = this.remembered?.gatt;
    const result = await VehicleLinkModule.connect({
      id: this.deviceId,
      transport: this.kind,
      profiles: GATT_PROFILES.map((p) => ({ id: p.id, service: p.service, notify: p.notify, write: p.write })),
      preferred: gatt ? [gatt.service, gatt.notify, gatt.write] : undefined,
      // A user-picked first connect times out; auto-connect and reconnects stay pending
      // until the adapter is back (§7, §11).
      timeoutMs: this.connectedOnce || options?.wait ? 0 : FIRST_CONNECT_TIMEOUT_MS,
    });
    this.connectedOnce = true;
    this.up = true;
    return {
      gatt: result.gatt,
      gattDump: result.gattDump,
      deviceInfo: result.deviceInfo,
      protocol: result.protocol,
    };
  }

  async disconnect(): Promise<void> {
    this.up = false;
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
    await VehicleLinkModule.disconnect();
  }

  async exchange(command: string, timeoutMs: number): Promise<RawExchange> {
    try {
      return await VehicleLinkModule.transact(command, timeoutMs);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Report the loss before the rejection reaches the session, so the owner tears down cleanly.
      if (code && LINK_ERRORS.has(code)) this.fireLinkLost(code);
      throw error;
    }
  }

  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void {
    return this.unsolicited.on(listener);
  }

  onLinkLost(listener: (reason: string) => void): () => void {
    return this.linkLost.on(listener);
  }

  private fireLinkLost(reason: string): void {
    if (!this.up) return;
    this.up = false;
    this.linkLost.emit(reason);
  }

  private listen(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      VehicleLinkModule.addListener("onLinkState", (e) => {
        if (e.state === "disconnected") this.fireLinkLost(e.reason ?? "disconnected");
      }),
      VehicleLinkModule.addListener("onUnsolicited", (e) => this.unsolicited.emit(e.text, e.rxUs)),
    );
  }
}
