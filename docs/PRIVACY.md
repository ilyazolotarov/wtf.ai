# wtf.ai privacy policy

Effective 22 October 2026.

wtf.ai is a car navigator that keeps working when satellite positioning is jammed or unreliable. It is built to work
offline, and it keeps your data on your phone. This policy describes what the app does with data. It covers the app
as distributed through the App Store and Google Play.

## The short version

- No account and no sign-up.
- Your position, routes, searches and trip logs stay on your phone unless you choose to share them or enable
  position sharing with other navigators or trip log upload for testers (below).
- No advertising, no tracking and no sale of your data. Data is shared only as described below.
- The app sends anonymous crash and error reports so that bugs can be fixed, and anonymous reports on whether it
  could read your car's wheel sensors (you can turn these off). They contain no location and no personal data.

## What stays on your phone

The app uses the following to work out where the car is. None of it leaves your phone unless you share it yourself,
except the short car compatibility report described below.

- **Location** (satellite positioning), while you use the app and during a drive with the screen locked; with
  automatic startup, also during a drive the app was started for by itself, even when it is closed or not in use.
- **Motion sensors**: accelerometer, gyroscope and magnetometer.
- **Your car's data over Bluetooth**, if you connect an OBD-II adapter: vehicle speed and, on some cars, wheel speeds,
  gear and steering. The app also reads the car's VIN to tell your cars apart.
- **Trip logs**: recordings of the above for each drive, used to calibrate the navigator to your car and phone.
- **Saved places, searches, routes and settings.**
- **Offline maps** that you download.

Uninstalling the app deletes all of it. You can also delete trip logs and maps in the app.

## What leaves your phone

**Crash and error reports.** When the app crashes or hits an error, it sends a report to Sentry (Functional Software,
Inc.), hosted in the European Union. A report contains the error, the app version, the phone model and operating system
version, technical measurements of app performance, and a random code created when the app was installed (shown in
Settings as "Support code", so that you can quote it if you report a problem). The app removes coordinates and VINs from
reports before sending them. Reports carry no name, email, phone number, contacts, photos or advertising identifier.
They are not used to identify you, and they are not combined with other data. Sentry deletes them after at most 90
days.

**Car compatibility reports.** The app can read the speed of each wheel from many cars' data bus, but how to read it
differs between car makes and models. The first time it reads a car's wheels, the app checks them against the car's
own speed for a few minutes before it relies on them. It then sends one report of the result with the crash and error
reports, to the same place: the car's make (such as "toyota"), which wheel-reading layout it tried, the message numbers
of the car's data bus it used and how often they came, the OBD protocol, the adapter's model, numbers comparing the
wheels with the car's speed, how long the check took and how fast the adapter answered. For a car the app has no
wheel-reading layout for, it can look for the car's speed on its data bus itself, and then reports what it found: the
message number and where the speed sits in it, or that it found none. When it found four wheels, it later works out
which is which from the phone's motion sensors as the car turns, and reports that too: which wheel each one is, and
the car's track and wheelbase as measured, in centimetres. It never contains the VIN or
any part of it, your location or the time of the drive. A report is sent once per result, not after every drive. You
can turn these reports off in Settings → Vehicle → Send anonymous car reports.

**Map and app update downloads.** The app downloads offline maps and app updates from the project's server. These
requests say which map region or app version is wanted, and nothing about where you are or where you drive. As with
any internet request, the server's hosting provider (Cloudflare) sees your IP address; the project's server keeps no
logs of these requests.

**Trip logs you share.** A trip log leaves your phone only if you share it yourself, for example by sending it with
the share sheet. A trip log contains the GPS track of the drive, sensor data and your car's VIN. Whoever you send it to
receives that data.

**Trip log upload for testers.** People who test the app for the developer can turn on trip log upload with a
personal code the developer gives them. It is off for everyone else, and the app cannot turn it on by itself.
Before the first log is sent, the app shows what will be sent and the name the developer knows the tester by. Then
each finished trip log (the GPS track of the drive, sensor data and the car's VIN and speeds) is sent to the
developer's private storage (Cloudflare R2), filed under that name, and deleted from the phone. The logs are used
only to test and improve the navigator, are never shared with anyone else and are kept until the tester asks for
them to be deleted. Turning upload off stops it at once.

**Position sharing with other navigators (Android).** If you enable Share the car's position in More → Waze and
Google Maps, the app supplies its position estimate to Android's location services during drives with the car
adapter connected. This includes the Google Play services location provider and, when GPS is unreliable, Android's
GPS provider. Waze, Google Maps and other apps that request location from these providers can receive this estimate
instead of the phone's GPS position. They handle it under their own privacy policies, just as they would the phone's
location. Sharing is off by default and stops when the drive ends.

## Permissions

- **Location**: to show and track your position and to guide you. Navigation can continue with the screen locked
  during a drive and for up to 15 minutes afterwards; iPhone shows the location indicator and Android a notification
  meanwhile. "Always" ("Allow all the time" on Android) is requested only if you choose automatic startup: it lets the
  app track the drive it starts for, even when it is closed or not in use. On iPhone, that feature also detects
  significant movement using cellular networks and Wi-Fi so iOS can launch the app when you set off.
- **Bluetooth**: to connect to an OBD-II adapter in your car. It is never used to find your location.
- **Notifications** (Android): the notification that keeps navigation running with the screen off.
- **Mock location** (Android): lets you select wtf.ai in Developer options to supply the car's position to other
  navigators. Sharing starts only after you select it there and enable the feature in the app.

You can refuse any permission. Without location the app can still show maps and search addresses.

## Age

The app is meant for drivers: it is for adults, not for children. Apart from the trip logs testers choose to send, it collects
no personal data from anyone.

## Your rights

Unless you send trip logs as a tester, the project holds no personal data about you, so there is nothing to access,
correct or delete on the project's side. Crash reports cannot be traced back to a person; if you quote your support
code, the reports carrying it can be deleted on request. A tester can ask for a copy of their uploaded logs, or for
their deletion, at any time.

## Changes

Changes to this policy are published at this address, with a new effective date.

## Contact

Questions and requests: SUPPORT_EMAIL.
