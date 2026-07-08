# TheRun Races Overlay

Compact OBS Browser Source overlay for live races on [therun.gg](https://therun.gg).

The app runs locally, reads a public TheRun race URL, and renders a small timing-tower style leaderboard with runner names, ratings, current times, race deltas, and finish/abandon status.

## Status

Version `1.0.0` is ready for release tagging after final live-race validation.

## Features

- Local OBS Browser Source overlay; no OBS plugin install required.
- Control page for pasting each new TheRun race URL without changing the OBS source.
- Runner names, ELO rating changes, current times, split progress, and race deltas.
- High-resolution default rendering with `zoom=3` for sharper OBS scaling.
- Transparent page background with a semi-transparent leaderboard panel.
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
http://localhost:5179
```

## Set The Race

Open the control page in your normal browser:

```text
http://localhost:5179/control
```

Paste a race URL such as:

```text
https://therun.gg/races/16c4
```

The OBS source keeps the same overlay URL and updates on its next poll.

## OBS Setup

Add an OBS Browser Source:

```text
URL:    http://localhost:5179/overlay
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
?panel=1                           use the old framed panel style
?theme=light                       use the light panel theme
```

Defaults:

```text
poll=1000
zoom=3
width=320
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
- Runners with incompatible split structures remain below the comparable leaderboard with no race delta.

## Display Rules

- `Finished (confirmed)` and `Finished (waiting for confirmation)` replace split text once a runner finishes.
- `Abandoned (...)` replaces split text once a runner abandons.
- Positive race deltas use red; negative race deltas use green.
- Race deltas use the same font size as the current time and sit close to the current time with a fixed gap.
- Long runner names are clipped so the ELO rating and rating delta stay visible.

## Data And Privacy

This tool only makes public `GET` requests to therun.gg race pages. It does not submit race actions, modify races, or require user credentials.

The app prefers TheRun's embedded public race payload when available and falls back to visible page sections when needed.

## Attribution And Licensing

This project is released under the MIT License. See [LICENSE](LICENSE).

See [NOTICE.md](NOTICE.md) for third-party notices.
