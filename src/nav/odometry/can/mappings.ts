// Per-make CAN mappings, written by hand from opendbc's `opendbc/car/<make>/carstate.py` (the pinned submodule in
// tools/can/opendbc): which message and signal give each quantity, its unit, sign and gear values. The signal layouts
// themselves come from the DBCs (`npm run can:profiles` → signals.json). Only what navigation can use is ported:
// wheel speeds, speed, gear, steering angle, brake, yaw rate. A mapping is trusted on a car only after the CAN shadow
// comparison (SPEC §2.1), so a wrong unit or factor here shows as a constant ratio to OBD speed, not as a wrong position.
//
// Alternatives are listed in carstate's order of preference; the decoder uses the first one whose message is on the
// bus, which stands in for carstate's per-platform flags. An alternative whose message a DBC lacks is dropped for that
// DBC. CAN FD platforms are left out: the STN adapters receive classic CAN only.

export type SpeedUnit = "kph" | "mph" | "mps";

export interface SignalRef {
  msg: string;
  sig: string;
}

/** A number from one signal, optionally `+ plus` (same message), negated when `signSig` is 1, then times `scale`. */
export interface ValueSource extends SignalRef {
  plus?: string;
  /** VW sends the sign of an unsigned magnitude in its own signal: 1 → negative. */
  signSig?: string;
  scale?: number;
}

export interface SpeedSource extends ValueSource {
  unit: SpeedUnit;
}

export interface WheelSource extends SignalRef {
  /** Direction signal of this wheel's side; the speed is negative when it reads `reverse`. */
  dir?: SignalRef & { reverse: number };
}

export interface WheelsSource {
  fl: WheelSource;
  fr: WheelSource;
  rl: WheelSource;
  rr: WheelSource;
  unit: SpeedUnit;
}

export type Gear = "P" | "R" | "N" | "D" | "S" | "L" | "B" | "E" | "T";

export type GearSource =
  /** A selector signal. Values from the DBC's value table (labels normalized like carstate's GEAR_SHIFTER_MAP) unless given. */
  | (SignalRef & { kind: "selector"; values?: Record<number, Gear> })
  /** Manual gearboxes: the reverse light. R while it is on, D otherwise. */
  | (SignalRef & { kind: "reverseLight" });

export type FlagSource = SignalRef & { on: "nonzero" | { eq: number[] } | { ge: number } };

export interface YawSource extends ValueSource {
  unit: "deg/s" | "rad/s";
}

export interface Mapping {
  /** Platform family, unique within the make. */
  name: string;
  /** opendbc DBC names (without .dbc) the family uses on its powertrain bus. */
  dbcs: string[];
  wheels?: WheelsSource;
  /** Vehicle speed as carstate reads it when it doesn't average the wheels (or as a second reference). */
  speed?: SpeedSource[];
  gear?: GearSource[];
  /** Steering wheel angle, degrees, positive left (openpilot's convention). */
  steer?: ValueSource[];
  /** Brake pedal: pressed when any present source says so (carstate ORs them). */
  brake?: FlagSource[];
  /** Yaw rate, positive left; only where carstate reads one. */
  yaw?: YawSource[];
  note?: string;
}

export interface MakeMappings {
  make: string;
  /** VIN world manufacturer identifiers (prefixes) of the make's brands. */
  wmi: string[];
  mappings: Mapping[];
}

const wheels4 = (msg: string, fl: string, fr: string, rl: string, rr: string, unit: SpeedUnit = "kph"): WheelsSource => ({
  fl: { msg, sig: fl },
  fr: { msg, sig: fr },
  rl: { msg, sig: rl },
  rr: { msg, sig: rr },
  unit,
});

const selector = (msg: string, sig: string, values?: Record<number, Gear>): GearSource => ({ kind: "selector", msg, sig, values });
const reverseLight = (msg: string, sig: string): GearSource => ({ kind: "reverseLight", msg, sig });
const nonzero = (msg: string, sig: string): FlagSource => ({ msg, sig, on: "nonzero" });
const eq = (msg: string, sig: string, ...values: number[]): FlagSource => ({ msg, sig, on: { eq: values } });

export const MAKES: MakeMappings[] = [
  {
    make: "byd",
    wmi: ["LGX", "LC0"],
    mappings: [
      {
        name: "atto3",
        dbcs: ["byd_atto3"],
        speed: [{ msg: "WHEELSPEED_CLEAN", sig: "WHEELSPEED_CLEAN", unit: "kph" }],
        gear: [selector("DRIVE_STATE", "GEAR", { 1: "P", 2: "R", 3: "N", 4: "D" })],
        steer: [{ msg: "STEER_MODULE_2", sig: "STEER_ANGLE_2" }],
        brake: [nonzero("DRIVE_STATE", "BRAKE_PRESSED")],
      },
    ],
  },
  {
    make: "chrysler",
    wmi: ["1C3", "1C4", "1C6", "2C3", "2C4", "3C4", "3C6", "3C7", "1J4", "1J8", "ZAC"],
    mappings: [
      {
        name: "stellantis",
        dbcs: ["chrysler_pacifica_2017_hybrid_generated", "chrysler_ram_dt_generated", "chrysler_ram_hd_generated"],
        // Not RAM: the mean of SPEED_LEFT and SPEED_RIGHT, already m/s. RAM: ESP_8.
        speed: [
          { msg: "ESP_8", sig: "Vehicle_Speed", unit: "kph" },
          { msg: "SPEED_1", sig: "SPEED_LEFT", plus: "SPEED_RIGHT", scale: 0.5, unit: "mps" },
        ],
        gear: [selector("Transmission_Status", "Gear_State"), selector("GEAR", "PRNDL")],
        steer: [{ msg: "STEERING", sig: "STEERING_ANGLE", plus: "STEERING_ANGLE_HP" }],
        brake: [eq("ESP_1", "Brake_Pedal_State", 1)],
      },
      {
        name: "cusw",
        dbcs: ["chrysler_cusw"],
        wheels: {
          fl: { msg: "WHEEL_SPEEDS_FRONT", sig: "WHEEL_SPEED_FL" },
          fr: { msg: "WHEEL_SPEEDS_FRONT", sig: "WHEEL_SPEED_FR" },
          rl: { msg: "WHEEL_SPEEDS_REAR", sig: "WHEEL_SPEED_RL" },
          rr: { msg: "WHEEL_SPEEDS_REAR", sig: "WHEEL_SPEED_RR" },
          unit: "mps",
        },
        speed: [{ msg: "BRAKE_1", sig: "VEHICLE_SPEED", unit: "mps" }],
        gear: [selector("GEAR", "PRNDL")],
        steer: [{ msg: "STEERING", sig: "STEER_ANGLE" }],
        brake: [nonzero("BRAKE_3", "DRIVER_BRAKE_SWITCH")],
      },
    ],
  },
  {
    make: "ford",
    wmi: ["1FA", "1FB", "1FC", "1FD", "1FM", "1FT", "2FM", "2FT", "3FA", "3FM", "3FT", "5LM", "1LN", "2LM", "3LN", "WF0", "NM0", "MAJ"],
    mappings: [
      {
        name: "ford",
        dbcs: ["ford_lincoln_base_pt"],
        speed: [{ msg: "BrakeSysFeatures", sig: "Veh_V_ActlBrk", unit: "kph" }],
        gear: [selector("PowertrainData_10", "TrnRng_D_Rq"), reverseLight("BCM_Lamp_Stat_FD1", "RvrseLghtOn_B_Stat")],
        steer: [{ msg: "SteeringPinion_Data", sig: "StePinComp_An_Est" }],
        brake: [eq("EngBrakeData", "BpedDrvAppl_D_Actl", 2)],
        yaw: [{ msg: "Yaw_Data_FD1", sig: "VehYaw_W_Actl", unit: "rad/s" }],
        note: "CAN FD platforms share this DBC; only the classic-CAN ones can be read.",
      },
    ],
  },
  {
    make: "gm",
    wmi: ["1G", "2G", "3G", "KL", "6G"],
    mappings: [
      {
        name: "global-a",
        dbcs: ["gm_global_a_powertrain_generated"],
        // The front wheels take the direction of the rear wheel on their side.
        wheels: {
          fl: { msg: "EBCMWheelSpdFront", sig: "FLWheelSpd", dir: { msg: "EBCMWheelSpdRear", sig: "RLWheelDir", reverse: 2 } },
          fr: { msg: "EBCMWheelSpdFront", sig: "FRWheelSpd", dir: { msg: "EBCMWheelSpdRear", sig: "RRWheelDir", reverse: 2 } },
          rl: { msg: "EBCMWheelSpdRear", sig: "RLWheelSpd", dir: { msg: "EBCMWheelSpdRear", sig: "RLWheelDir", reverse: 2 } },
          rr: { msg: "EBCMWheelSpdRear", sig: "RRWheelSpd", dir: { msg: "EBCMWheelSpdRear", sig: "RRWheelDir", reverse: 2 } },
          unit: "kph",
        },
        gear: [selector("ECMPRDNL2", "PRNDL2")],
        steer: [{ msg: "PSCMSteeringAngle", sig: "SteeringWheelAngle" }],
        // Camera-harness cars read ECMEngineStatus; the others a pedal position ≥ 8 (loose push rods read low values).
        brake: [nonzero("ECMEngineStatus", "BrakePressed"), { msg: "ECMAcceleratorPos", sig: "BrakePedalPos", on: { ge: 8 } }],
      },
    ],
  },
  {
    make: "honda",
    wmi: ["JHM", "JHL", "JH4", "1HG", "2HG", "2HK", "2HJ", "5FN", "5FP", "5J6", "5J8", "19X", "19U", "SHH", "SHS", "7FA", "MRH", "LUC"],
    mappings: [
      {
        name: "honda",
        dbcs: [
          "acura_ilx_2016_can_generated",
          "acura_rdx_2018_can_generated",
          "acura_rdx_2020_can_generated",
          "honda_bosch_radarless_generated",
          "honda_civic_hatchback_ex_2017_can_generated",
          "honda_civic_touring_2016_can_generated",
          "honda_common_canfd_generated",
          "honda_crv_touring_2016_can_generated",
          "honda_e_advance_2020_can_generated",
          "honda_insight_ex_2019_can_generated",
          "honda_odyssey_exl_2018_generated",
          "honda_odyssey_twn_2018_generated",
        ],
        wheels: wheels4("WHEEL_SPEEDS", "WHEEL_SPEED_FL", "WHEEL_SPEED_FR", "WHEEL_SPEED_RL", "WHEEL_SPEED_RR"),
        // carstate blends this in below 6 km/h (more accurate there) and multiplies it by wheelSpeedFactor (1.025 on
        // some models).
        speed: [{ msg: "ENGINE_DATA", sig: "XMISSION_SPEED", unit: "kph" }],
        gear: [
          selector("GEARBOX_AUTO", "GEAR_SHIFTER"),
          selector("GEARBOX_CVT", "GEAR_SHIFTER"),
          reverseLight("SCM_FEEDBACK", "REVERSE_LIGHT"),
          reverseLight("SCM_BUTTONS", "REVERSE_LIGHT"),
        ],
        steer: [{ msg: "STEERING_SENSORS", sig: "STEER_ANGLE" }],
        // carstate also needs BRAKE_SWITCH on for two frames in a row; the pressed bit alone is enough here.
        brake: [nonzero("POWERTRAIN_DATA", "BRAKE_PRESSED"), nonzero("BRAKE_MODULE", "BRAKE_PRESSED")],
      },
    ],
  },
  {
    make: "hyundai",
    wmi: ["KMH", "KMF", "KM8", "5NP", "5NM", "TMA", "NLH", "MAL", "KNA", "KNC", "KND", "KNE", "5XX", "5XY", "3KP", "U5Y", "U6Y", "KMT"],
    mappings: [
      {
        name: "can",
        dbcs: ["hyundai_can_generated"],
        wheels: wheels4("WHL_SPD11", "WHL_SPD_FL", "WHL_SPD_FR", "WHL_SPD_RL", "WHL_SPD_RR"),
        // carstate picks one by platform flags: hybrid/EV, then the lever, the gearbox, the cluster, fuel cell.
        gear: [
          selector("ELECT_GEAR", "Elect_Gear_Shifter"),
          selector("LVR12", "CF_Lvr_Gear"),
          selector("TCU12", "CUR_GR"),
          selector("CLU15", "CF_Clu_Gear"),
          selector("EMS20", "HYDROGEN_GEAR_SHIFTER"),
        ],
        steer: [{ msg: "SAS11", sig: "SAS_Angle" }],
        // 2 includes regenerative braking by the driver on hybrids and EVs.
        brake: [eq("TCS13", "DriverOverride", 2)],
      },
    ],
  },
  {
    make: "mazda",
    wmi: ["JM1", "JM3", "JMZ", "3MZ", "3MV", "7MM", "MM8"],
    mappings: [
      {
        name: "mazda",
        dbcs: ["mazda_2017"],
        wheels: wheels4("WHEEL_SPEEDS", "FL", "FR", "RL", "RR"),
        speed: [{ msg: "ENGINE_DATA", sig: "SPEED", unit: "kph" }],
        gear: [selector("GEAR", "GEAR")],
        steer: [{ msg: "STEER", sig: "STEER_ANGLE" }],
        brake: [eq("PEDALS", "BRAKE_ON", 1)],
      },
    ],
  },
  {
    make: "mg",
    wmi: ["LSJ"],
    mappings: [
      {
        name: "mg",
        dbcs: ["mg"],
        speed: [{ msg: "SCS_HSC2_FrP19", sig: "VehSpdAvgHSC2", unit: "kph" }],
        gear: [
          selector("GW_HSC2_ECM_FrP04", "TrEstdGearHSC2", {
            15: "P", 14: "R", 13: "N", 1: "D", 2: "D", 3: "D", 4: "D", 5: "D", 6: "D", 7: "D", 8: "D",
          }),
        ],
        steer: [{ msg: "SAS_HSC2_FrP00", sig: "StrgWhlAngHSC2" }],
        brake: [eq("EHBS_HSC2_FrP00", "BrkPdlAppdHSC2", 1)],
      },
    ],
  },
  {
    make: "nissan",
    wmi: ["JN1", "JN3", "JN6", "JN8", "1N4", "1N6", "3N1", "3N6", "5N1", "SJN", "VSK", "VNV"],
    mappings: [
      {
        name: "nissan",
        dbcs: ["nissan_x_trail_2017_generated", "nissan_leaf_2018_generated"],
        wheels: {
          fl: { msg: "WHEEL_SPEEDS_FRONT", sig: "WHEEL_SPEED_FL" },
          fr: { msg: "WHEEL_SPEEDS_FRONT", sig: "WHEEL_SPEED_FR" },
          rl: { msg: "WHEEL_SPEEDS_REAR", sig: "WHEEL_SPEED_RL" },
          rr: { msg: "WHEEL_SPEEDS_REAR", sig: "WHEEL_SPEED_RR" },
          unit: "kph",
        },
        gear: [selector("GEARBOX", "GEAR_SHIFTER")],
        steer: [{ msg: "STEER_TORQUE_SENSOR", sig: "STEER_ANGLE" }],
        brake: [nonzero("DOORS_LIGHTS", "USER_BRAKE_PRESSED"), nonzero("CRUISE_THROTTLE", "USER_BRAKE_PRESSED")],
      },
    ],
  },
  {
    make: "psa",
    wmi: ["VF3", "VF7", "VR3", "VR7"],
    mappings: [
      {
        name: "aee2010",
        dbcs: ["psa_aee2010_r3"],
        wheels: wheels4(
          "Dyn4_FRE",
          "P263_VehV_VPsvValWhlFrtL",
          "P264_VehV_VPsvValWhlFrtR",
          "P265_VehV_VPsvValWhlBckL",
          "P266_VehV_VPsvValWhlBckR",
        ),
        gear: [reverseLight("Dat_BSI", "P103_Com_bRevGear")],
        steer: [{ msg: "STEERING_ALT", sig: "ANGLE" }],
        brake: [nonzero("Dat_BSI", "P013_MainBrake")],
        yaw: [{ msg: "HS2_DYN_UCF_MDD_32D", sig: "VITESSE_LACET_BRUTE", unit: "deg/s" }],
      },
    ],
  },
  {
    make: "rivian",
    wmi: ["7FC", "7PD"],
    mappings: [
      {
        name: "rivian",
        dbcs: ["rivian_primary_actuator"],
        speed: [{ msg: "ESP_Status", sig: "ESP_Vehicle_Speed", unit: "kph" }],
        gear: [selector("VDM_PropStatus", "VDM_Prndl_Status", { 1: "P", 2: "R", 3: "N", 4: "D" })],
        steer: [{ msg: "EPAS_AdasStatus", sig: "EPAS_InternalSas" }],
        brake: [eq("iBESP2", "iBESP2_BrakePedalApplied", 1)],
      },
    ],
  },
  {
    make: "subaru",
    wmi: ["JF1", "JF2", "4S3", "4S4", "4S6"],
    mappings: [
      {
        name: "subaru",
        dbcs: [
          "subaru_global_2017_generated",
          "subaru_global_2020_hybrid_generated",
          "subaru_forester_2017_generated",
          "subaru_outback_2015_generated",
          "subaru_outback_2019_generated",
        ],
        wheels: wheels4("Wheel_Speeds", "FL", "FR", "RL", "RR"),
        gear: [selector("Transmission", "Gear")],
        // Steering_Torque's angle is always zero on the newer angle-steered cars; Steering_2 has it where it exists.
        steer: [
          { msg: "Steering_2", sig: "Steering_Angle" },
          { msg: "Steering_Torque", sig: "Steering_Angle" },
        ],
        brake: [eq("Brake_Status", "Brake", 1), nonzero("Brake_Pedal", "Brake_Pedal")],
      },
    ],
  },
  {
    make: "tesla",
    wmi: ["5YJ", "7SA", "LRW", "XP7", "7G2"],
    mappings: [
      {
        name: "model3",
        dbcs: ["tesla_model3_party"],
        speed: [{ msg: "DI_speed", sig: "DI_vehicleSpeed", unit: "kph" }],
        gear: [selector("DI_systemStatus", "DI_gear", { 1: "P", 2: "R", 3: "N", 4: "D" })],
        steer: [{ msg: "EPAS3S_sysStatus", sig: "EPAS3S_internalSAS", scale: -1 }],
        brake: [eq("ESP_status", "ESP_driverBrakeApply", 2)],
      },
    ],
  },
  {
    make: "toyota",
    wmi: ["JT", "2T", "4T", "5T", "6T", "SB1", "NMT", "MR0", "MR2", "VNK", "AHT", "8AJ", "9BR"],
    mappings: [
      {
        name: "toyota",
        dbcs: ["toyota_nodsu_pt_generated", "toyota_new_mc_pt_generated", "toyota_tnga_k_pt_generated", "toyota_secoc_pt_generated"],
        // carstate multiplies by wheelSpeedFactor (1.035 on the RX).
        wheels: wheels4("WHEEL_SPEEDS", "WHEEL_SPEED_FL", "WHEEL_SPEED_FR", "WHEEL_SPEED_RL", "WHEEL_SPEED_RR"),
        gear: [selector("GEAR_PACKET_HYBRID", "GEAR"), selector("GEAR_PACKET", "GEAR")],
        // carstate prefers the torque sensor's angle once its offset to this one is learned.
        steer: [{ msg: "STEER_ANGLE_SENSOR", sig: "STEER_ANGLE", plus: "STEER_FRACTION" }],
        brake: [nonzero("BRAKE_MODULE", "BRAKE_PRESSED")],
      },
    ],
  },
  {
    make: "volkswagen",
    wmi: ["WVW", "WVG", "WV1", "WV2", "WV3", "1VW", "3VW", "9BW", "WAU", "WA1", "TRU", "WUA", "VSS", "TMB", "XW8", "LFV", "LSV"],
    mappings: [
      {
        name: "mqb",
        dbcs: ["vw_mqb"],
        wheels: wheels4("ESP_19", "ESP_VL_Radgeschw_02", "ESP_VR_Radgeschw_02", "ESP_HL_Radgeschw_02", "ESP_HR_Radgeschw_02"),
        gear: [
          selector("Gateway_73", "GE_Fahrstufe"),
          selector("Motor_EV_01", "MO_Waehlpos"),
          reverseLight("Gateway_72", "BCM1_Rueckfahrlicht_Schalter"),
        ],
        steer: [{ msg: "LWI_01", sig: "LWI_Lenkradwinkel", signSig: "LWI_VZ_Lenkradwinkel" }],
        brake: [nonzero("Motor_14", "MO_Fahrer_bremst"), nonzero("ESP_05", "ESP_Fahrer_bremst")],
      },
      {
        name: "pq",
        dbcs: ["vw_pq"],
        // Bremse_1 rather than the Bremse_3 wheel speeds: Bremse_3 isn't on every car.
        speed: [{ msg: "Bremse_1", sig: "BR1_Rad_kmh", unit: "kph" }],
        gear: [selector("Getriebe_1", "GE1_Wahl_Pos"), reverseLight("Gate_Komf_1", "GK1_Rueckfahr")],
        steer: [{ msg: "Lenkhilfe_3", sig: "LH3_BLW", signSig: "LH3_BLWSign" }],
        brake: [nonzero("Motor_2", "MO2_BLS")],
      },
      {
        name: "meb",
        dbcs: ["vw_meb_generated", "vw_meb_2024_generated"],
        wheels: wheels4("ESC_51", "VL_Radgeschw", "VR_Radgeschw", "HL_Radgeschw", "HR_Radgeschw"),
        gear: [selector("Getriebe_11", "GE_Fahrstufe"), selector("Gateway_73", "GE_Fahrstufe")],
        steer: [{ msg: "LWI_01", sig: "LWI_Lenkradwinkel", signSig: "LWI_VZ_Lenkradwinkel" }],
        brake: [nonzero("Motor_14", "MO_Fahrer_bremst")],
        yaw: [{ msg: "ESC_50", sig: "Yaw_Rate", signSig: "Yaw_Rate_Sign", scale: -1, unit: "deg/s" }],
      },
      {
        name: "mlb",
        dbcs: ["vw_mlb"],
        wheels: wheels4("ESP_03", "ESP_VL_Radgeschw", "ESP_VR_Radgeschw", "ESP_HL_Radgeschw", "ESP_HR_Radgeschw"),
        gear: [selector("Getriebe_03", "GE_Waehlhebel")],
        steer: [{ msg: "LWI_01", sig: "LWI_Lenkradwinkel", signSig: "LWI_VZ_Lenkradwinkel" }],
        brake: [nonzero("Motor_03", "MO_Fahrer_bremst"), nonzero("ESP_05", "ESP_Fahrer_bremst")],
      },
    ],
  },
];
