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
