# When GPS fails

[[Українська|When-GPS-fails-uk]]

## What the app does on its own

1. **The signal is lost.** With an adapter connected, the dot keeps moving from the last trusted position using
   the car's speed and turns measured by the phone.
2. **Minutes later.** Small errors add up and the circle grows. Unsure between two parallel roads, the app shows the
   other one as a hollow ring.
3. **A turn refines the position.** If the turn matches only one of the roads, the ring disappears and the
   uncertainty circle shrinks.
4. **Spoofing.** A GPS position that jumps somewhere the car can't have driven is ignored; a grey dot shows where GPS
   *claims* you are.
5. **GPS returns.** The app checks new positions against the car's movement for a few seconds before the status
   turns green again.

Usually, no action is needed: **keep driving normally.**

## Put the car on the map

If the car is stopped and the dot is clearly on the wrong road, press and hold the map where the car really is, tap
**I'm here**, then tap the road ahead to show which way the car faces. The dot carries on from there.

## "Is the car where the dot is?"

When you set off without GPS, the app starts from where you parked. If Wi-Fi suggests somewhere else, it asks. *Yes*
keeps the parking spot; *No* lets you show where the car is. Not sure? Leave the question unanswered: it disappears
once GPS provides a reliable position.

## Without an adapter

The app can't tell how far the car goes, only how it turns. To navigate anyway:

1. Set your position on the map while the car is stopped.
2. Follow the route exactly. If you leave it, stop and set your position again.

Connect an [[adapter|Car-adapter]] before your next drive so the app can keep tracking the car.
