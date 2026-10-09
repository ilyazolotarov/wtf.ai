# Guide & onboarding prototype

Clickable prototype of the in-app guide: the first-run onboarding, the map tour, the Guide entry in More, and
nine interactive lessons. Made in Claude Design ("wtf.ai Guide & Onboarding" canvas,
https://claude.ai/artifact/CfkGafY9sp67PK88W3bVsY, private to the owner). The canvas is the place to view and
edit it; these files are its source, kept here so the design is versioned with the code that implements it.

The `.dc.html` files need the Claude Design runtime (`support.js`), so they don't render when opened directly in a
browser. Read them for layout, copy and behaviour: each file is one 390×844 phone screen, its markup at the top and
its state logic in the `<script type="text/x-dc">` block at the bottom.

| File | Screen |
| --- | --- |
| `canvas.json` | Canvas layout: which screens exist and where they sit |
| `Main.dc.html` | Onboarding: welcome → location → car → phone holder (new step) |
| `Tour.dc.html` | Map tour: invite card, then six coach marks on the map's controls |
| `More.dc.html` | More sheet with "How to use wtf.ai" as its first row (the Guide is not in Settings) |
| `Guide.dc.html` | Guide hub: the map tour, nine lessons in four groups, progress |
| `LessonBefore.dc.html` | 1 · Before you drive: checklist (map, adapter, holder, open the app, charging) |
| `LessonStatus.dc.html` | 2 · What the dot is telling you: the five trust states on a map |
| `LessonCar.dc.html` | 3 · The car button: green / yellow / red / Driving |
| `LessonJamming.dc.html` | 4 · Driving through jamming: a drive played in five stages, with and without the adapter |
| `LessonPlace.dc.html` | 5 · Put the car on the map: practice of the placing flow |
| `LessonPose.dc.html` | 6 · "Is the car where the dot is?": both answers |
| `LessonRoute.dc.html` | 7 · Plan a route: press and hold, or search |
| `LessonVoice.dc.html` | 8 · Spoken directions: mute, hold for the speaker picker, volume |
| `LessonMaps.dc.html` | 9 · Offline maps: download, switch, leaving the region |

Notes for implementing it:

- Colours, type and radii are the app's Calm theme (`src/constants/theme.ts`, Onest). The lesson maps are SVG and
  are meant to be ported to `react-native-svg` almost as they are.
- Copy reuses the app's strings where they exist (`src/i18n/en.ts`); lesson text is new and needs Ukrainian.
- Driver advice is an action, never "Nothing": "Keep driving normally."
- `[size]`, `[street]`, `[Car stereo]`, `[version]` are placeholders for real values; "Kyiv Oblast" is an example
  region.
- If the canvas changes, copy its files here again (they live under `project/` in the artifact).
