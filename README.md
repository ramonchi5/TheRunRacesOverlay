# TheRun Races Overlay

Compact OBS Browser Source overlay for live races on [therun.gg](https://therun.gg).

The app runs locally, reads a public TheRun race URL, and renders a small timing-tower style leaderboard with runner names, ratings, current times, latest split progress, and race deltas.

## Status

This is a first working release candidate. It is ready for live-race testing before tagging `v1.0.0`.

## Features

- Local OBS Browser Source overlay.
- Control page for pasting each new TheRun race URL without changing the OBS source.
- Runner ranking, current race time, latest split time, and completion percent.
- Race delta comparison with the fastest finished runner as the baseline once anyone finishes.
- Optional subsplit display and comparison with `Subsplits=On`.
- High-resolution default rendering with `zoom=3` for sharper OBS scaling.
- Transparent page background with a semi-transparent leaderboard panel.

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

Add an OBS Browser Source.

For normal splits:

```text
URL:    http://localhost:5179/overlay
Width:  1100
Height: 900
```

For subsplits:

```text
URL:    http://localhost:5179/overlay?Subsplits=On
Width:  1400
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
?width=390                         override the automatic overlay width
?zoom=2                            override the default render zoom
?panel=1                           use the old framed panel style
?theme=light                       use the light panel theme
?Subsplits=On                      display and compare subsplits
```

By default:

```text
zoom=3
width=350 without subsplits
width=420 with Subsplits=On
```

If `width=` is present in the URL, it always overrides the automatic width.

Subsplits are off by default. They only turn on when `Subsplits=On`, `subsplits=on`, or another truthy subsplits value is present in the URL.

## Race Ordering

Before anyone finishes, runners are ordered by the latest comparable completed split.

After anyone finishes:

- The fastest finished runner becomes the baseline and #1.
- Other finished runners are ordered by final time.
- Runners still racing are ordered after finished runners by their delta against the fastest finished runner at their latest completed comparable split.
- Runners with incompatible split structures stay below the comparable leaderboard with no race delta.

## Attribution And Licensing

This project is released under the MIT License. See [LICENSE](LICENSE).

See [NOTICE.md](NOTICE.md) for third-party notices.

## Notes

This tool only makes public `GET` requests to therun.gg race pages. It does not submit race actions, modify races, or require user credentials.
