import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/car-play (iOS; docs/CARPLAY-SPEC.md §4). Null on Android, on web and in builds without it.

export interface CarTrip {
  originLat: number;
  originLon: number;
  destinationLat: number;
  destinationLon: number;
  destinationName?: string | null;
  /** The route in the trip's card ("18 min · 12 km"). */
  summary: string;
}

export interface CarManeuver {
  instruction: string;
  /** An SF Symbol name. */
  symbol: string;
  /** From the previous maneuver (the first: from the car), m and s. */
  distanceM: number;
  timeS: number;
}

export interface CarEstimates {
  toNextM: number;
  toNextS: number;
  remainingM: number;
  remainingS: number;
}

declare class CarPlayNativeModule extends NativeModule {
  startTrip(trip: CarTrip): Promise<void>;
  setManeuvers(maneuvers: CarManeuver[]): Promise<void>;
  updateEstimates(estimates: CarEstimates): Promise<void>;
  endTrip(arrived: boolean): Promise<void>;
}

export default requireOptionalNativeModule<CarPlayNativeModule>("CarPlay");
