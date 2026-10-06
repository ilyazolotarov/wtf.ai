# wtf.ai on Android: guide for testers

Thank you for testing. wtf.ai is an early test build of a navigator that keeps a position when GPS is jammed or
spoofed. **Do not rely on it for real navigation.** It runs on Android 8 or newer. You need an OBD-II Bluetooth
adapter (ELM327 type) plugged into the car to try the full thing; without one the map still works from the phone's GPS.

## 1. Install

1. Open the link you were given and download the `.apk` file.
2. Open the downloaded file. Android asks to allow installing apps from this source (your browser or Telegram): allow it
   for this one install.
3. If Google Play Protect says "unrecognized app" or "app scan recommended", choose **More details → Install anyway**.
   This build is not on Google Play.
4. To update later, install the new `.apk` the same way. Your settings and trip logs are kept.

## 2. First start

1. Open wtf.ai and follow the first screens.
2. Allow **Location** (precise) and choose "While using the app".
3. Allow **Nearby devices** (Bluetooth) when asked, and **Notifications** (needed so Android keeps the app running while
   you drive).

## 3. Connect the OBD adapter

1. Plug the adapter into the car's OBD-II port and switch the ignition on.
2. In wtf.ai tap **Vehicle** (the car icon in the bar at the bottom of the map).
3. If your adapter is not in the list: tap **New adapter**, pair it in Android's Bluetooth settings (PIN `1234`, or
   `0000` if that fails), then go back to the app. Paired adapters appear in the list.
4. Tap the adapter. When it says connected you will see a **Disconnect** button.

Tested adapter types: Vgate vLinker FD+ and generic ELM327 clones. Other adapters may work. If yours does not, the
**Settings** (More → Settings → About) shows a **Support code**; send it with a description (see §6).

## 4. Keep the app alive while driving (important)

Phone makers stop background apps to save battery. This breaks recording when the screen is off.

1. Open Android **Settings → Apps → wtf.ai → Battery** and choose **Unrestricted** (or "Don't optimize").
2. Samsung: Settings → Battery → Background usage limits → remove wtf.ai from "Sleeping apps" and "Deep sleeping apps".
3. Xiaomi / Redmi / Poco: Settings → Apps → Manage apps → wtf.ai → Autostart **on**, Battery saver **No restrictions**.
4. Huawei / Honor: Settings → Battery → App launch → wtf.ai → Manage manually, all three switches on.
5. Other makes: see the list at dontkillmyapp.com.

While a trip is recorded you see a notification "wtf.ai is recording your trip". It must stay; it is what keeps the app
running with the screen off.

## 5. A test drive

1. Mount the phone rigidly (a firm car holder); the phone's gyroscope is the only turn sensor.
2. Connect the adapter, start the engine, and drive. A trip starts and ends on its own.
3. Try it with the screen off for a few minutes, then wake it: the dot should still be where the car is.
4. Afterwards open **Vehicle**, go to the recorder tab, tap **Trips**, pick the trip, and share the log file with the
   person who gave you this build.

## 6. Reporting a problem

Send:

- What you did and what happened (screenshots help).
- Your phone model and Android version.
- The **Support code** (More → Settings → About).
- The trip log, if the problem happened on a drive.

The app sends crash reports and health numbers (connection time, how often the adapter answers, whether the sensors kept
running with the screen off). They contain no positions, no VIN and no adapter serial number. Your trip logs leave the
phone only when you share them.
