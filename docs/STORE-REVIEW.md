# wtf.ai — App Store and Google Play review

Status: v1 (2026-10-13). What makes a build acceptable to App Review and Google Play review, what the store build
changes, and the answers the two consoles ask for. Distribution today is sideloading (SPEC §2, UPDATES-SPEC); this is
the store path next to it, not a replacement.

## 1. The store build

`DISTRIBUTION=store` at build time (app.config.js, `STORE_BUILD` in `src/config/distribution.ts`). Everything else is
the same app, one source tree.

| Sideloaded build                                    | Store build                                         | Why                                                   |
| --------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Android installs its own APK updates (`REQUEST_INSTALL_PACKAGES`) | Permission removed and blocked; no native-build check | Play: apps update only through Play (Device and Network Abuse) |
| Library-default permissions nothing uses: `SYSTEM_ALERT_WINDOW`, `ACTIVITY_RECOGNITION`, `USE_BIOMETRIC`, `USE_FINGERPRINT` | Blocked | Each one is a question in Play review |
| iOS App update screen points to AltStore, shares the IPA | Neither: only JS updates and "Restart"          | App Review 3.2.2: no other app store, no app installers |
| Opt-in trip log upload with a developer's code      | Off (`tripUploadUrl` null)                          | A tester-only feature with no way for review to test it; keeps precise location out of the privacy labels |
| Developer row in More                               | Hidden until seven taps on Version in Settings      | App Review 2.2: no test or beta features in front of users |
| Privacy text names the tester upload                | `privacyMessageStore`                               | Matches what the build does                           |

Both builds: the privacy manifest, the purpose strings and the Settings → Privacy policy link (§2), JS updates over the
air (§4.3).

Must not drift: a store build never downloads or installs native code, never links to AltStore or an IPA/APK, and
never contains `REQUEST_INSTALL_PACKAGES` (`build-store.yml` fails if it does).

## 2. Both builds

- **Privacy policy**: [PRIVACY.md](PRIVACY.md) and its Ukrainian twin [PRIVACY.uk.md](PRIVACY.uk.md), on the website as
  `privacy.html` / `privacy.uk.html` (`pages.yml`). Settings → Privacy opens the one in the app's language
  (`PRIVACY_POLICY_URL`, by default the file on GitHub in the CI's repository; `privacyPolicyUrl()` swaps in the
  Ukrainian one). Both stores need the URL in each listing: the Ukrainian listing gets the Ukrainian policy. Change
  both whenever data handling changes (Sentry fields, a new upload, a new permission).
- **iOS privacy manifest**: `ios.privacyManifests` in app.json. Required-reason APIs: the union of every dependency's
  `PrivacyInfo.xcprivacy` (Apple misses those of static pods) plus our modules' `systemUptime` (SystemBootTime
  35F9.1). After adding a native dependency, run the scan in §6 and add new reasons. Collected data = §3.3.
- **Purpose strings** (app.json plugins, localized in `locales/*.json`): each says what the app does with it. No
  library default (`Allow $(PRODUCT_NAME) to access…`) may reach the build: App Review rejects vague ones (5.1.1).
  Face ID is removed (unused). The microphone string stays though nothing records: expo-audio links recording APIs, and
  App Store Connect refuses an upload that references them without a string (ITMS-90683).
- **Location**: When In Use only; background updates only during a drive (TRIP-LOGGER-SPEC §4.3) with the indicator.
  The "Always" strings exist because expo-location links the API; the app never requests it.
- **Encryption**: `ITSAppUsesNonExemptEncryption: false`: HTTPS only, MD5/SHA-256 for checksums. No export filing.
- **No account**, so no account deletion requirement (5.1.1(v)). No ads, no tracking, no IDFA, no in-app purchases.

## 3. Apple App Store

### 3.1 Needs the owner

- A paid Apple Developer Program membership (SPEC §9.7). Then: App ID `ai.wtf.navigator`, an App Store distribution
  certificate and profile, an App Store Connect API key, the app record.
- An App Store Connect API key with the Admin role (Users and Access → Integrations), stored as the secrets
  `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the .p8 file's text), and the team id as the variable
  `APPLE_TEAM_ID`. Then Actions → **Build App Store iOS App** (`build-ios-store.yml`) archives with cloud-managed
  signing on the macOS runner and uploads to App Store Connect; no Mac, no certificate files. Without the key it builds
  the store app unsigned (a compile check) and checks its Info.plist and privacy manifest either way.
- Screenshots (6.9" and 6.5" iPhone at least), description, keywords, support URL (the GitHub repo), privacy policy
  URL, age rating: 13+ (answer "Infrequent/Mild Profanity or Crude Humor": the name stands for "Where the f\* am I?"; a driving app has no audience below that anyway).

### 3.2 Review information (paste into App Store Connect)

**MFi accessories.** Declared protocol strings and their authorizations (SPEC §9.4); list every one, or remove the
string from `mfiProtocols` before submitting:

- `com.obdlink`: OBDLink MX+, OBD Solutions LLC, PPID 221699-0001
- `com.vgatemall`: Vgate vLinker FS / MS, ShenZhen CheBoTong, PPIDs 649626-099130, 649626-112572

**Notes:**

> wtf.ai is a car navigator for places where GPS is jammed or spoofed. It works offline: maps, routes and address
> search come from a region the user downloads once. No account is needed.
>
> The app works in Ukraine only. Outside it, a GPS position is what spoofing looks like there, so the app refuses it
> and says "GPS puts you outside Ukraine". To review from abroad, without a car adapter:
> 1. On first launch, pick a small region, for example Kyiv (the city), and download it.
> 2. On the map, tap "Set position", move the map to any street in Kyiv, tap "Here", then tap the road ahead.
>    The status then reads "GPS looks spoofed · Set on the map": the app keeps the position you gave it.
> 3. Tap Route, search "Khreshchatyk", choose Khreshchatyk Street and tap Start guidance.
> 4. More › How to use? has interactive lessons, including "Driving through jamming", which plays a jammed drive.
>
> An OBD-II Bluetooth adapter (BLE, or the MFi adapters listed) adds the car's speed, which keeps navigation accurate
> when GPS is unavailable. It is optional. Without one, the app navigates with GPS and the phone's motion sensors.
>
> Background modes: location (guidance and trip recording continue with the screen locked, only during a drive),
> audio (spoken turn directions with the screen locked), bluetooth-central and external-accessory (the car adapter
> stays connected during a drive).
>
> The app downloads JavaScript updates for its own code (bug fixes); they never change its purpose (Guideline 2.5.2,
> 3.3.1(B)).

### 3.3 App Privacy (nutrition label)

| Data type                                   | Collected | Linked to the user | Tracking | Purpose           |
| ------------------------------------------- | --------- | ------------------ | -------- | ----------------- |
| Diagnostics → Crash Data                    | yes       | no                 | no       | App Functionality |
| Diagnostics → Performance Data              | yes       | no                 | no       | App Functionality |
| Diagnostics → Other Diagnostic Data         | yes       | no                 | no       | App Functionality |
| Identifiers → Device ID (the install's random support code) | yes | no      | no       | App Functionality |
| Location, contacts, user content, usage data, everything else | no |       |          |                   |

Must match `NSPrivacyCollectedDataTypes` in app.json.

### 3.4 Review risks

- **Name**: "wtf.ai" and its expansion. The iOS tagline is "Where the funk am I?" (`src/constants/brand.ts`, 1.1).
  If review objects to the name itself, the display name (`expo.name`) can change without touching anything else.
- **Minimum functionality (4.2)** and **completeness (2.1)**: the notes give a path a reviewer abroad can follow.
  Test it on a fresh install before each submission.
- **JS updates (2.5.2)**: publish only fixes and features within the app's purpose; never use one to switch on what a
  reviewed build did not have.

## 4. Google Play

### 4.1 Needs the owner

- A Play Console developer account. A new personal account must run a closed test with at least 12 testers for 14
  days before it can apply for production.
- Play App Signing: upload the bundle signed with the `android-release` key, which becomes the upload key.
- Listing: short and full description, phone screenshots, a 512×512 icon, a 1024×500 feature graphic, privacy policy
  URL, contact email.

### 4.2 The bundle

`.github/workflows/build-store.yml`, run by hand on `main`: `DISTRIBUTION=store`, prebuild, `bundleRelease` for all
four ABIs, signed with the `android-release` key, the merged manifest checked (no `REQUEST_INSTALL_PACKAGES`, no
`ACCESS_BACKGROUND_LOCATION`), `wtfai-play.aab` as the artifact. Not published to our server, not announced. Target
SDK comes from the Expo SDK (Play requires the latest year's API level for updates; a new SDK keeps it current).

### 4.3 Console declarations

- **Foreground service types** (Play's FGS declaration, each with a short video of the feature):
  - `location`: navigation and trip recording continue with the screen off during a drive.
  - `connectedDevice`: the OBD-II adapter stays connected during a drive.
  - `mediaPlayback` (expo-audio): spoken turn directions with the screen off.
- **Location**: foreground only (fine and coarse). No background location permission, so no background location
  declaration.
- **Bluetooth**: `BLUETOOTH_SCAN` is `neverForLocation`.
- **App access**: no login; all functionality available. Paste the §3.2 notes for the reviewer.
- **Ads**: none. **Content rating** (IARC): no violence, no user interaction, no data sharing; mention the masked
  word in the Android tagline "Where the f* am I?" under language if the questionnaire asks.
- **Target audience**: 18 and over (drivers). Adding 16–17 (learner drivers) is harmless; never under 13, which brings
  the Families policy.
- **Data safety**:
  - Collected: App info and performance → Crash logs, Diagnostics; Device or other IDs → the install's random code.
    Purpose: App functionality. Not shared (Sentry processes it on our behalf). Not optional (sent by every build
    with a DSN).
  - Encrypted in transit: yes. Deletion: on request with the support code (PRIVACY.md).
  - Location: not collected (it never leaves the phone; a trip log shared by the user is user-initiated sharing,
    which Play does not count as collection).

## 5. Before each submission

1. `DISTRIBUTION=store npx expo config --type introspect`: no `REQUEST_INSTALL_PACKAGES`; every `…UsageDescription` is
   ours (none starts with "Allow $(PRODUCT_NAME) to access").
2. On a store build: More has no Developer row; App update shows no AltStore or IPA; Settings opens the privacy
   policy; the Trip recorder has no upload section.
3. A fresh install follows the §3.2 notes end to end.
4. PRIVACY.md and PRIVACY.uk.md, §3.3 and §4.3 still describe what the build sends.

## 6. Required-reason API scan

After adding or updating a native dependency, list the reasons its pods declare and add new ones to app.json:

```bash
find node_modules -name PrivacyInfo.xcprivacy | while read -r f; do
  python -c "import plistlib,sys; d=plistlib.load(open(sys.argv[1],'rb'))
for a in d.get('NSPrivacyAccessedAPITypes',[]): print(a['NSPrivacyAccessedAPIType'], *a['NSPrivacyAccessedAPITypeReasons'])" "$f"
done | sort -u
```

Our own Swift (`modules/*/ios`) adds `systemUptime` → SystemBootTime 35F9.1.

## 7. Listing text

Paste into App Store Connect and the Play Console; keep it true to what the build does (App Review 2.3, Play
Metadata policy). Character limits in brackets. No other app, store or competitor named.

### English

- **Name** [30]: `wtf.ai — Where the funk am I?` (both stores; never "f\*" in a store title: Play's Metadata policy
  refuses profanity in titles, masked or not, and App Review 1.1 the same; in the app Android keeps "f\*")
- **Subtitle** (App Store) [30]: `Navigation when GPS is jammed`
- **Short description** (Play) [80]: `Offline car navigation that keeps your position when GPS is jammed or spoofed.`
- **Keywords** (App Store) [100]: `gps,jamming,spoofing,offline,navigation,map,obd,obd2,car,route,ukraine,dead reckoning,elm327`
- **Description**:

> During air raids, satellite positioning is jammed or spoofed: the dot on the map freezes, or jumps hundreds of
> kilometres away. wtf.ai keeps knowing where your car is.
>
> • Keeps your position without GPS: it continues from the last trusted fix using the car's speed and the phone's
>   motion sensors, and locks the position to the road network.
> • Spots fake positions: a satellite fix that disagrees with how the car is actually moving is refused.
> • Fully offline: download your region once; the map, address search, routes and voice guidance then work without
>   internet.
> • Turn-by-turn voice guidance, in English or Ukrainian.
> • Optional OBD-II Bluetooth adapter: plugs into the car and gives the exact vehicle speed, which keeps the position
>   accurate for hours without GPS. The app works without one too.
> • Private: no account, and your position never leaves the phone.
>
> Maps: Ukraine and each of its regions, from OpenStreetMap.

### Українська

- **Назва** [30]: `wtf.ai — Where the funk am I?` (як англійською: так само в програмі, `src/constants/brand.ts`)
- **Підзаголовок** [30]: `Навігація, коли GPS заглушено`
- **Короткий опис** [80]: `Офлайн-навігатор, що знає, де авто, навіть коли GPS заглушено або підмінено.`
- **Ключові слова** [100]: `gps,глушіння,спуфінг,офлайн,навігатор,мапа,obd,obd2,авто,маршрут,україна,elm327`
- **Опис**:

> Під час повітряних тривог супутникову навігацію глушать або підмінюють: точка на мапі завмирає чи стрибає за сотні
> кілометрів. wtf.ai і далі знає, де ваше авто.
>
> • Тримає позицію без GPS: продовжує від останньої надійної позиції за швидкістю авто й датчиками руху телефона та
>   прив'язує її до доріг.
> • Розпізнає підмінені координати: позицію, що не збігається з реальним рухом авто, відкинуто.
> • Повністю офлайн: завантажте свій регіон один раз, і мапа, пошук адрес, маршрути й голосові підказки працюють без
>   інтернету.
> • Голосові підказки поворотів українською або англійською.
> • Необов'язковий Bluetooth-адаптер OBD-II: під'єднується до авто й дає точну швидкість, тож позиція лишається
>   точною годинами без GPS. Без нього програма теж працює.
> • Приватність: без реєстрації, ваша позиція не залишає телефон.
>
> Мапи: уся Україна та кожна область, з OpenStreetMap.

### Screenshots and video

- **Google Play**: `python scripts/store-screenshots.py out-dir [--dark] [--video]` against the emulator with a
  store Release build installed: first run, the Kyiv download, a drive on emulated GPS, then guidance, a destination,
  search, the spoofed state at 60 km/h on the app's emulated OBD adapter (the car carries on along the road on its own
  speed), the jamming lesson and Offline maps, at 1080×2160 with a clean status bar; `--video`
  records the spoofing and the lesson for the promo video (Play takes a YouTube link). Re-run after UI changes. The
  website uses the light set (`site/assets/screens/`). The current Play set and video are in `store-assets/play/`
  (`light`, `dark`, `promo.mp4`; `uk-light`, `uk-dark`, `promo-uk.mp4` from `--lang uk`, the app in Ukrainian from its first screen, for the Ukrainian listing and `site/uk.html`), in
  Git LFS like every screenshot and video (`.gitattributes`).
- **App Store**: screenshots of the iOS app (2.3.3), so not from the emulator: take them on an iPhone with a store or
  sideloaded build, same scenes. Sizes: 6.9" (1320×2868) or 6.5" (1284×2778); no iPad (`supportsTablet` unset).
- Play also wants the 512×512 icon (`assets/images/icon.png` scaled) and a 1024×500 feature graphic.

### Availability

Both stores: Ukraine only (App Store Connect → Pricing and Availability; Play → Countries / regions). Outside
Ukraine the app refuses GPS by design; reviewers still test from abroad, which the notes in §3.2 cover.
