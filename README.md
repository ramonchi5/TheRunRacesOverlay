# TheRun Races Overlay

Compact OBS Browser Source overlay for live races on [therun.gg](https://therun.gg).

The app runs locally, reads a public TheRun race URL, and renders a small timing-tower style leaderboard with runner names, ratings, current times, race deltas, and finish/abandon status.

## Status

Version `1.0.4` is ready for release.

## Features

- Local OBS Browser Source overlay; no OBS plugin install required.
- Control page for pasting each new TheRun race URL without changing the OBS source.
- Runner names, ELO rating changes, current times, split progress, and race deltas.
- High-resolution default rendering with `zoom=3` for sharper OBS scaling.
- Transparent page background with semi-transparent leaderboard bands.
- Main split comparison that collapses nested split rows into their parent split group.
- Finished runners ordered by final time, with the fastest finisher as the baseline.
- Live runners compared only against matching completed split positions.
- Abandoned runners placed at the bottom; the earliest abandoner is last.

## Requirements

- Node.js 18 or newer.
- OBS Studio with a Browser Source.
- A public race page from therun.gg.

No therun.gg login is needed.

## Start

Double-click:

```text
start-overlay.bat
```

Or run from PowerShell:

```powershell
.\start-overlay.ps1
```

The local server starts at:

```text
http://127.0.0.1:5179
```

## Release Package

The GitHub release asset is:

```text
release/TheRunRacesOverlay-v1.0.4.zip
```

The zip contains:

- `public/`
- `server.js`
- `package.json`
- `start-overlay.bat`
- `start-overlay.ps1`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `NOTICE.md`

Only `server.js` and `public/` are strictly required at runtime. The start scripts, package metadata, README, changelog, license, and notices are included so the release is easy to run and carries its attribution/licensing context.

## Set The Race

Open the control page in your normal browser:

```text
http://127.0.0.1:5179/control
```

Paste a race URL such as:

```text
https://therun.gg/races/16c4
```

The OBS source keeps the same overlay URL and updates on its next poll.

## OBS Setup

Add an OBS Browser Source:

```text
URL:    http://127.0.0.1:5179/overlay
Width:  1100
Height: 900
```

Use more height for larger races. After setting the Browser Source size, resize the source down on the OBS canvas. This keeps text sharper than rendering small and scaling up.

## URL Options

```text
?race=16c4                         pin a specific race id
?race=https://therun.gg/races/16c4  pin a specific race URL
?poll=1000                         refresh every 1 second
?title=off                         hide the header
?limit=4                           show only the top 4 runners
?width=220                         override the automatic overlay width
?zoom=2                            override the default render zoom
?TitleFontSize=14                  set title size; unitless values are px
?TitleFontSize=0.86rem             set title size with CSS units
?panel=1                           use the old framed panel style
?theme=light                       use the light panel theme
```

Defaults:

```text
poll=1000
zoom=3
width=290
TitleFontSize=13
```

If `width=` is present in the URL, it overrides the automatic width.

Width overrides accept values from `120` to `2400`. Extra width is given to the runner name/split column. The delta and current-time columns stay compact with a fixed small gap.

## Race Ordering

Before anyone finishes:

- Runners with comparable main split counts are ordered by their latest comparable completed main split.
- Race deltas compare the same completed main split position only.
- The overlay does not compare against another runner's current timer as a split delta fallback.

After anyone finishes:

- The fastest finished runner becomes the baseline and #1.
- Other finished runners are ordered by final time and keep deltas against the fastest finisher.
- Runners still racing are ordered after finished runners by their latest comparable split delta against the fastest finisher.
- Abandoned runners are ordered at the bottom. If multiple runners abandon, the later abandoner ranks above the earlier abandoner, so the first to abandon is last.
- Disqualified runners are placed below abandoned runners with `#-` and `DSQ`.
- Runners with incompatible split structures remain below the comparable leaderboard with no race delta.

## Display Rules

- `Finished (confirmed)` and `Finished (waiting for confirmation)` replace split text once a runner finishes.
- `Abandoned` replaces split text once a runner abandons; abandoned rows show the abandon time in red when available and do not show confirmation text.
- Disqualified rows keep the red `Abandoned` outcome label and show red `DSQ` in the time column.
- `Ready` and `Not Ready` display before a runner has started and before any split has been completed.
- Live runners display their current runner timer in the right column.
- Live runners display their latest completed split below the name as `time at split name`.
- ELO rating changes are hidden until TheRun reports a real post-race rating.
- Positive race deltas use red; negative race deltas use green.
- Race deltas use the same font size as the current time and sit close to the current time with a fixed gap.
- Long runner names are clipped so the ELO rating and rating delta stay visible.
- Runner rows are separated by `1.5px` transparent gaps instead of drawn divider lines.
- Position numbers sit on full-height semi-transparent square lanes.
- The race title is centered, uppercase, transparent behind the text, wraps onto extra lines instead of being abbreviated, and can be resized with `TitleFontSize`.
- The row background padding is balanced on both sides, matching the space before the position tile with the space after the current time.

## Data And Privacy

This tool only makes public `GET` requests to therun.gg race pages. It does not submit race actions, modify races, or require user credentials.

The app prefers TheRun's embedded public race payload when available and falls back to visible page sections when needed.

## Attribution And Licensing

This project is released under the MIT License. See [LICENSE](LICENSE).

See [NOTICE.md](NOTICE.md) for third-party notices.
