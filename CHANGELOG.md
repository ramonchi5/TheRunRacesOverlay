# Changelog

## 3.0.2 - 2026-07-12

- Added a native Windows x64 OBS source that renders the leaderboard directly with GDI+ instead of a Browser Source/CEF capture.
- Added native source properties for race selection, output dimensions, typography, opacity, gradients, shadows, outlines, and polling.
- Reused the local Node.js backend so the native and browser editions share the same tested race ordering, parent-split, delta, and stale-data behavior.
- Made the native outline optional and disabled by default, kept thin ELO text solid-colored, and moved depth into a multi-sample shadow drawn behind each glyph.
- Added a release installer for OBS's recommended `C:\ProgramData\obs-studio\plugins` directory.
- Added English and Spanish labels for the native OBS source properties.
- Added a `Fancy` release line for native v3 builds while preserving `main` as the local-URL v2 line.

## 2.0.2 - 2026-07-11

- Added an always-on vertical three-color gradient to every overlay text element, preserving each element's existing semantic color in the middle.
- Added a very thin semi-transparent black outline tuned to stay subtle on both main labels and small ELO text.
- Added a wider, softer offset black shadow that separates the text from video without darkening the gradient fill.
- Applied the foreground treatment to the live-stream indicator while leaving all leaderboard backgrounds unchanged.
- Added a `release/TheRunRacesOverlay-v2.0.2.zip` package without modifying previous release archives.

## 2.0.1 - 2026-07-11

- Excluded participants that TheRun marks `visible: false`.
- Added timing-method detection and suppressed race deltas between mixed IGT/RTA runners while preserving physical race order.
- Preserved the last successful race snapshot through temporary TheRun request failures, with a quiet overlay warning and detailed control-page status.
- Added control-only diagnostics for timing method, runner state, parent-split progress, split-plan matching, and delta comparability.
- Added compact `SPLIT x/y` parent-split progress beneath the title.
- Added a brief row highlight when a runner completes a parent split.
- Added a small red indicator before names of runners that TheRun reports as streaming.
- Coalesced simultaneous overlay/control polls so they share one upstream TheRun request.
- Prevented a delayed diagnostics response for an old race from replacing diagnostics for a newly selected race.
- Removed obsolete dual-profile fields, unreachable ranking fallback code, internal-only API fields, and unused CSS.
- Hardened the local control endpoint to same-origin JSON use and made race-id parsing reject trailing junk.
- Added regression tests for mixed timing methods, invisible participants, stale-data fallback, request coalescing, strict race ids, and public payload cleanup.
- Added a `release/TheRunRacesOverlay-v2.0.1.zip` package without modifying previous release archives.

## 2.0.0 - 2026-07-10

- Added complete parent-split detection for nested LiveSplit layouts by reading each runner's public `.lss` plan.
- Kept raw subsplits out of progress, compatibility, leadership, and delta calculations.
- Added exact wall-clock split-arrival timestamps from TheRun's public race event history.
- Changed active leadership to furthest completed parent split, then earliest real-world arrival at that split.
- Kept displayed race deltas based on runner timer values at the latest shared parent split, allowing valid negative deltas behind the physical leader.
- Kept finished runners ordered by final time, with compatible active runners following by live race position.
- Added regression tests for subsplit parsing, full-plan grouping, split-event arrival matching, active leadership, negative deltas, split-count selection, and finish takeover.
- Added a `release/TheRunRacesOverlay-v2.0.0.zip` package without modifying previous release archives.

## 1.0.4 - 2026-07-09

- Removed confirmation text from abandoned rows.
- Added disqualification handling: DSQ rows show red `Disqualified (reason)`, red disqualification time, use `-`, and sit below abandoned runners.
- Added a `release/TheRunRacesOverlay-v1.0.4.zip` package.

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
