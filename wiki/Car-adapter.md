# Car adapter (OBD-II)

[[Українська|Car-adapter-uk]]

An OBD-II Bluetooth adapter plugs into the diagnostic port under the dashboard, found in nearly every car made
since the early 2000s. It reports the car's **speed** so the app can calculate the distance travelled, while the
phone's sensors measure turns.

**Without an adapter**, navigation works while GPS is reliable. If the signal is lost, the app can't measure the
distance travelled: the dot stays at the last trusted position and its uncertainty circle grows quickly. You can
still follow a route exactly (see [[When GPS fails]]), but navigation during GPS outages requires an adapter.

## Which adapter

When polling for speed, the app sends two requests per second. The adapter needs to respond **every time, without
gaps**, and stay connected throughout the drive. All the adapters we tested meet this requirement, including a cheap
clone.

| Phone   | What connects                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| Android | **Any Bluetooth ELM327 adapter**: Bluetooth LE or classic Bluetooth, and the MFi models below too           |
| iPhone  | **Bluetooth LE** ELM327 adapters, and **OBDLink MX+** and **vLinker FS / MS** (Apple MFi, supported by us)  |

### Tested by us

- **OBDLink MX+**: road-tested on two cars, one of them an older car on K-line. iPhone through Apple MFi, Android
  through classic Bluetooth. Press its button to pair.
- **vLinker FD-IOS** (Bluetooth LE): road-tested; steady speed, connects by itself.
- **A no-name "ELM327 v1.5"** (classic Bluetooth, so Android only): road-tested on an older car on K-line. It gave
  the speed every time the app asked, including on a drive with no GPS at all.

### Recommended, not road-tested yet

- **OBDLink CX** (Bluetooth LE). The maker tunes it mainly for BMW and it doesn't speak the older protocols of GM and
  Ford cars from before 2008. Pairing asks for the code **123456**, and works only within 5 minutes after the adapter
  is plugged in: missed it? Unplug it and plug it back in.
- **vLinker MC+, FD+, BM+** (Bluetooth LE): the "+" models of the family we tested.
- **vLinker FS, MS**: on iPhone through Apple MFi (we have the maker's authorization), on Android through Bluetooth.

### Should work, not road-tested

- **Other cheap ELM327 clones** ("v1.5", "v2.1", no-name, Konnwei): most are classic Bluetooth only, so Android only.
  The one we drove with worked, but clones differ from batch to batch: a branded adapter is the safer buy.
- **Simpler branded ELM327 adapters**: Vgate iCar Pro BLE / iCar2, Veepeak OBDCheck BLE / BLE+, LELink, Carista,
  Viecar, FIXD. They connect, but we haven't driven with them.

### Won't work

- **On iPhone, classic-only models without Apple MFi**: OBDLink LX and MX (without "+"), vLinker BM, MC and FD
  without "+", BAFX, most blue "ELM327" clones. iOS doesn't let apps access these adapters. They work on Android.
- **Dongles made for their own app**: OBDeleven, Thinkdiag, Topdon TopScan, Autel AP200, BlueDriver, XTOOL iOBD2,
  Innova, Carly. They don't speak ELM327: the app may list them but gets no data.
- **USB or Wi-Fi only**: OBDLink EX (USB), Wi-Fi ELM327 adapters.

### Buying one

- iPhone: the box says **"Bluetooth LE"** or **"BLE"**, or it is one of the MFi models above. Plain "Bluetooth" means
  classic: Android only.
- From Vgate vLinker, choose **FD-IOS**, a **"+"** model (MC+, FD+, BM+), or FS / MS.
- A "v1.5" or "v2.1" clone for the price of a coffee can work on Android; a branded adapter is the safer buy.

Tried an adapter that isn't listed? Let us know how it went at SUPPORT_EMAIL.

## Connecting

1. Plug the adapter in and switch the ignition on.
2. Tap the **car button** at the bottom of the map, then **Connect**.
3. iPhone with OBDLink MX+ or vLinker FS / MS: press the adapter's button (or plug it in), then **New adapter**.
   Android with a classic adapter: pair it in Bluetooth settings first (PIN 1234 or 0000).

The first connection to a new car can take a couple of minutes while the app finds how to talk to it. After that it
connects by itself whenever you open the app in the car.

## The car button

| Status  | What it means                                  | What to do                      |
| ------- | ---------------------------------------------- | ------------------------------- |
| Green   | Connected, the car answers                     | Drive normally                  |
| Yellow  | Connecting, or the engine is off               | Switch the ignition on and wait |
| Red     | No adapter found, or the car stopped answering | Tap it to see what is missing   |
| Driving | A trip is on                                   | Drive normally                  |
