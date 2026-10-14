# wtf.ai privacy policy

Effective 13 October 2026.

wtf.ai is a car navigator that keeps working when satellite positioning is jammed or unreliable. It is built to work
offline, and it keeps your data on your phone. This policy describes what the app does with data. It covers the app
as distributed through the App Store and Google Play.

## The short version

- No account and no sign-up.
- Your position, routes, searches and trip logs stay on your phone.
- No advertising, no tracking, no selling or sharing of data with anyone.
- The app sends anonymous crash and error reports so that bugs can be fixed. They contain no location and no personal
  data.

## What stays on your phone

The app uses the following to work out where the car is. None of it leaves your phone unless you share it yourself
(see below).

- **Location** (satellite positioning), while you use the app and during a drive with the screen locked.
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

**Map and app update downloads.** The app downloads offline maps and app updates from the project's server. These
requests say which map region or app version is wanted, and nothing about where you are or where you drive. As with
any internet request, the server's hosting provider (Cloudflare) sees your IP address; the project's server keeps no
logs of these requests.

**Trip logs you share.** A trip log leaves your phone only if you share it yourself, for example by sending it with
the share sheet. A trip log contains the GPS track of the drive, sensor data and your car's VIN. Whoever you send it to
receives that data.

## Permissions

- **Location**: to show and track your position and to guide you. In the background it is used only during a drive
  and for up to 15 minutes after it, so that guidance continues with the screen locked; iPhone shows the location
  indicator and Android a notification meanwhile. The app never asks for "Always" access.
- **Bluetooth**: to connect to an OBD-II adapter in your car. It is never used to find your location.
- **Notifications** (Android): the notification that keeps navigation running with the screen off.

You can refuse any permission. Without location the app can still show maps and search addresses.

## Age

wtf.ai is meant for drivers: it is for adults, not for children. It collects no personal data from anyone.

## Your rights

Since the project holds no personal data about you, there is nothing to access, correct or delete on the project's
side. Crash reports cannot be traced back to a person; if you quote your support code, the reports carrying it can be
deleted on request.

## Changes

Changes to this policy are published at this address, with a new effective date.

## Contact

Questions and requests: open an issue in this project's GitHub repository, where this policy is published.
