# Car adapter (OBD-II)

[[Українська|Car-adapter-uk]]

An OBD-II Bluetooth adapter plugs into the diagnostic port under the dashboard, which nearly every car from the
2000s on has. The app reads the car's **speed** from it, twice a second. When GPS is jammed, that speed is what
keeps the dot moving the right distance; the phone supplies the turns.

**Without an adapter** the app still works while GPS is good. When GPS goes away it can't tell how far the car moves:
the dot stays at the last good position and the circle around it grows quickly. You can still navigate by following
a route exactly (see [[When GPS fails]]), but an adapter is what makes the app useful under jamming.

## Which adapter

The app reads the speed twice a second. What matters is that the adapter answers **every time, without gaps**, and
keeps the connection for the whole drive: branded adapters do, cheap clones often don't.

| Phone   | What connects                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| Android | **Any Bluetooth ELM327 adapter**: Bluetooth LE or classic Bluetooth, and the MFi models below too           |
| iPhone  | **Bluetooth LE** ELM327 adapters, and **OBDLink MX+** and **vLinker FS / MS** (Apple MFi, supported by us)  |

### Tested by us

- **OBDLink MX+**: road-tested on two cars, one of them an older car on K-line. iPhone through Apple MFi, Android
  through classic Bluetooth. Press its button to pair.
- **vLinker FD-IOS** (Bluetooth LE): road-tested; steady speed, connects by itself.

### Recommended, not road-tested yet

- **OBDLink CX** (Bluetooth LE). The maker tunes it mainly for BMW and it doesn't speak the older protocols of GM and
  Ford cars from before 2008. Pairing asks for the code **123456**, and works only within 5 minutes after the adapter
  is plugged in: missed it? Unplug it and plug it back in.
- **vLinker MC+, FD+, BM+** (Bluetooth LE): the "+" models of the family we tested.
- **vLinker FS, MS**: on iPhone through Apple MFi (we have the maker's authorization), on Android through Bluetooth.

### Works, but not recommended

- **Cheap ELM327 clones** ("v1.5", "v2.1", no-name, Konnwei): many are classic Bluetooth only, so Android only. On
  our test the first connection to a car took over two minutes, and answers are slower and can come with gaps.
- **Simpler branded ELM327 adapters**: Vgate iCar Pro BLE / iCar2, Veepeak OBDCheck BLE / BLE+, LELink, Carista,
  Viecar, FIXD. They connect, but we haven't driven with them.

### Won't work

- **On iPhone, classic Bluetooth only**: OBDLink LX and MX (without "+"), vLinker BM, MC and FD without "+", BAFX,
  most blue "ELM327" clones. iOS doesn't let apps use classic Bluetooth. (On Android they work.)
- **Dongles made for their own app**: OBDeleven, Thinkdiag, Topdon TopScan, Autel AP200, BlueDriver, XTOOL iOBD2,
  Innova, Carly. They don't speak ELM327: the app may list them but gets no data.
- **USB or Wi-Fi only**: OBDLink EX (USB), Wi-Fi ELM327 adapters.

### Buying one

- iPhone: the box says **"Bluetooth LE"** or **"BLE"**, or it is one of the MFi models above. Plain "Bluetooth" means
  classic: Android only.
- From Vgate vLinker, take a **"+"** model (MC+, FD+, BM+), or FS / MS.
- A "v1.5" or "v2.1" adapter for the price of a coffee is exactly the class we don't recommend.

Tried an adapter that isn't listed? Tell us in an issue how it went.

## Connecting

1. Plug the adapter in and switch the ignition on.
2. Tap the **car button** at the bottom of the map, then **Connect**.
3. iPhone with OBDLink MX+ or vLinker FS / MS: press the adapter's button (or plug it in), then **New adapter**.
   Android with a classic adapter: pair it in Bluetooth settings first (PIN 1234 or 0000).

The first connection to a new car can take a couple of minutes while the app finds how to talk to it. After that it
connects by itself whenever you open the app in the car.

## The car button

| Dot     | Means                                          | You                             |
| ------- | ---------------------------------------------- | ------------------------------- |
| Green   | Connected, the car answers                     | Drive normally                  |
| Yellow  | Connecting, or the engine is off               | Switch the ignition on and wait |
| Red     | No adapter found, or the car stopped answering | Tap it to see what is missing   |
| Driving | A trip is on                                   | Drive normally                  |
