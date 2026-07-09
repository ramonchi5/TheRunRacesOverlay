# Changelog

## 1.0.3 - 2026-07-09

- Changed abandoned rows to show only the red `Abandoned` outcome under the runner name and the abandon time in red when available.
- Extracted abandon times from TheRun's visible `Abandoned - time` card text when embedded live data is unavailable.
- Removed the title background band so the title sits visually separate from runner rows.
- Added a `release/TheRunRacesOverlay-v1.0.3.zip` package.

## 1.0.2 - 2026-07-09

- Fixed pre-race runners with `0:00` being shown as finished.
- Fixed pre-race ELO display using `ratingAfter: 0` as a real rating change.
- Changed documented local URLs from `localhost` to `127.0.0.1` to avoid slow localhost resolution on some Windows setups.
- Added `Ready` and `Not Ready` display before runners start.
- Kept live split display on active runners as `time at split name`.
- Kept the right-side timer column on the live runner timer instead of the latest split time.
- Ignored zero-time split predictions so future splits are not treated as completed splits.
- Added a `release/TheRunRacesOverlay-v1.0.2.zip` package.

## 1.0.0 - 2026-07-08

- Added a local OBS Browser Source overlay for therun.gg races.
- Added a control page for changing races without editing the OBS source URL.
- Added ranking, current time, ELO rating, ELO delta, split progress, and race-delta display.
- Added finished-run baseline deltas and confirmation status display.
- Added abandoned-run display and bottom-of-leaderboard ordering.
- Collapsed nested split rows into parent main splits for comparison.
- Added high-resolution default rendering for sharper OBS scaling.
- Tightened the delta/current-time timing column for a more compact default overlay width and narrower width overrides.
- Added F1-style `1.5px` row gaps, full-height position lanes, uppercase wrapping title styling, and balanced row padding.
- Added `TitleFontSize` URL option for title sizing, defaulting to `13`.
- Set the default overlay width to `290`.
- Added a `release/TheRunRacesOverlay-v1.0.0.zip` package with README, changelog, license, and notices.
- Added MIT license and third-party notices.
