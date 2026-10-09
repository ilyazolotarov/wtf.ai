import { SymbolView, type SymbolViewProps } from "expo-symbols";

type SFSymbol = Extract<SymbolViewProps["name"], string>;

/** Material Symbols names from the design, mapped to SF Symbols on iOS. */
const SF = {
  satellite_alt: "dot.radiowaves.left.and.right",
  gpp_maybe: "exclamationmark.shield.fill",
  sync: "arrow.triangle.2.circlepath",
  gps_off: "location.slash.fill",
  directions_car: "car.fill",
  alt_route: "arrow.triangle.branch",
  more_horiz: "ellipsis",
  my_location: "location.fill",
  navigation: "location.north.fill",
  location_searching: "location",
  search: "magnifyingglass",
  chevron_right: "chevron.right",
  bluetooth: "dot.radiowaves.left.and.right",
  download: "arrow.down.circle.fill",
  map: "map.fill",
  tune: "slider.horizontal.3",
  monitoring: "waveform.path.ecg",
  settings: "gearshape.fill",
  lock: "lock.fill",
  check_circle: "checkmark.circle.fill",
  radio_button_checked: "largecircle.fill.circle",
  radio_button_unchecked: "circle",
  close: "xmark",
  delete: "trash",
  arrow_back: "chevron.left",
  location_off: "location.slash.fill",
  location_on: "location.fill",
  // Route guidance (ROUTING-SPEC §8).
  straight: "arrow.up",
  turn_right: "arrow.turn.up.right",
  turn_left: "arrow.turn.up.left",
  turn_slight_right: "arrow.up.right",
  turn_slight_left: "arrow.up.left",
  turn_sharp_right: "arrow.down.right",
  turn_sharp_left: "arrow.down.left",
  fork_right: "arrow.triangle.branch",
  fork_left: "arrow.triangle.branch",
  u_turn_left: "arrow.uturn.down",
  roundabout_left: "arrow.counterclockwise",
  flag: "flag.checkered",
  place: "mappin.and.ellipse",
  home: "house.fill",
  work: "briefcase.fill",
  star: "star.fill",
  star_border: "star",
  history: "clock.arrow.circlepath",
  volume_up: "speaker.wave.2.fill",
  volume_off: "speaker.slash.fill",
  // The voice playing off the phone (a car's Bluetooth, AirPlay).
  airplay: "airplayaudio",
} as const satisfies Record<string, SFSymbol>;

export type IconName = keyof typeof SF;

export function Icon({
  name,
  size = 24,
  color,
}: {
  name: IconName;
  size?: number;
  color: string;
}) {
  return (
    <SymbolView
      name={{ ios: SF[name], android: name, web: name }}
      size={size}
      tintColor={color}
      type="monochrome"
    />
  );
}
