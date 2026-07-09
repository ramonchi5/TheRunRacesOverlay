# Changelog

## 1.0.2 - 2026-07-09

- Fixed pre-race runners with `0:00` being shown as finished.
- Fixed pre-race ELO display using `ratingAfter: 0` as a real rating change.
- Added `Ready` and `Not Ready` display before runners start.
- Kept live split display on active runners as `time at split name`.
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
