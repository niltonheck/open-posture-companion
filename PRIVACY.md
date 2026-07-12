# Privacy Policy — Open Posture Companion

**Effective date: July 11, 2026**

Open Posture Companion is an independent, open-source companion app for the
discontinued Upright GO 1 posture trainer. This policy describes what the app
does with data — which is simple, because it collects none.

## What the app does NOT do

- **No data collection.** The app has no analytics, no crash reporting, no
  advertising SDKs, and no third-party services that receive data.
- **No accounts.** There is nothing to sign up for and no identity attached
  to your use of the app.
- **No cloud sync or transmission.** The app makes no network requests with
  your data. Posture data never leaves your phone.

## What stays on your device

The app talks to your Upright GO 1 over Bluetooth Low Energy and stores,
**locally on your phone only**:

- Per-day posture summaries (minutes upright/slouched, slouch counts) for up
  to the last 30 days, after which they are deleted.
- The identifier of the last connected device, so the app can reconnect to
  it automatically.

Deleting the app deletes all of this data. There is no copy anywhere else.

## Bluetooth

Bluetooth access is used exclusively to find and communicate with compatible
Upright GO 1 posture devices. On iOS, the app may maintain the Bluetooth
connection in the background so posture minutes keep counting while the
phone is locked; this changes nothing about where data lives (your phone).
No location data is collected; on Android the scan is declared
`neverForLocation`.

## Changes and contact

The app is open source — the code is the authoritative description of its
behavior: https://github.com/niltonheck/open-posture-companion

Questions or concerns: open an issue on the repository above.

---

*Open Posture Companion is an independent open-source interoperability
project, not affiliated with, endorsed by, sponsored by, or approved by
UPRIGHT or any related company. This app is not a medical device.*
