# TheRun Races Overlay

Compact native OBS source for live races on [therun.gg](https://therun.gg), with the original Browser Source available as a fallback.

The backend reads a public TheRun race URL. OBS can display the resulting timing-tower leaderboard through the native Windows source or the original browser overlay.

## Status

Version `3.2.3` is the self-contained native OBS plugin line and is ready for live-race testing.

The `Fancy` branch contains v3 releases. Version `3.2.3` adds source-managed backend startup to the v3.1.3 renderer while retaining the race behavior shared with Browser Source version `2.0.3` on `main`.

## Features

- Native Windows OBS source with supersampled GDI+ rendering and in-OBS appearance controls.
- Bundled backend runtime that starts invisibly when a leaderboard is shown and stops after the last leaderboard is hidden.
- Browser Source fallback with no OBS plugin installation required.
- Control page for pasting each new TheRun race URL without changing the OBS source.
- Runner names, ELO rating changes, current times, split progress, and race deltas.
- High-resolution default rendering with `zoom=3` for sharper OBS scaling.
- Transparent page background with semi-transparent leaderboard bands.
- Full split-plan detection from each nested runner's public `.lss` file, with subsplits collapsed into parent groups.
- Active leadership based on who reached the furthest parent split first in real-world time.
- Race deltas based on each runner's own LiveSplit time at the latest shared parent split.
- Mixed IGT/RTA detection that preserves physical race order while suppressing invalid cross-timing deltas.
- Finished runners ordered by final time, with the fastest finisher as the baseline.
- Abandoned runners placed at the bottom; the earliest abandoner is last.
- Control-page diagnostics for timing method, split-plan matching, parent-split progress, and delta comparability.
- Compact parent-split progress, split-completion highlights, and live-stream dots on the overlay.
- Last successful race data remains on screen during temporary TheRun connection failures.
- Adjustable semantic-color gradients, subtle outlines, and soft shadows across overlay text and live indicators.

## Requirements

- OBS Studio 31 or newer on Windows x64 for the native source.
- Node.js 18 or newer only when using the optional Browser Source fallback or manual backend scripts.
- Any OBS Studio version with Browser Source support for the browser fallback.
- A public race page from therun.gg.

No therun.gg login is needed.

## Managed Backend

The native v3.2.3 plugin includes its own backend runtime. No BAT file needs to be started. The DLL launches one hidden backend process when the first TheRun leaderboard becomes visible, shares it across every visible leaderboard source, and stops it when the final source is hidden or OBS exits.

The default **Start bundled backend automatically** setting uses `http://127.0.0.1:5179`. Disable it only when supplying a separately managed backend URL.

The control page is available while a native leaderboard source is visible:

```text
http://127.0.0.1:5179/control
```

The native source deliberately reuses the tested JavaScript backend so split/subsplit, ordering, delta, and stale-data behavior still have one implementation. Node.js is bundled inside the plugin; users do not need to install it for native v3 operation.

For the optional Browser Source fallback, Node.js 18+ and the manual scripts remain available:

```text
start-overlay.bat
start-overlay.ps1
```

## Native OBS Source

### Standard OBS Installation

Extract the v3 release anywhere on the PC and double-click:

```text
install-obs-plugin.bat
```

This copies the complete native module folder to OBS's recommended Windows plugin directory:

```text
C:\ProgramData\obs-studio\plugins\therun-races-overlay
```

The plugin remains installed after reboot. Restart OBS after installing it, then add this source:

```text
TheRun Race Leaderboard
```

Paste a full TheRun race URL or race ID directly into the source properties. An empty race field follows the race selected at `http://127.0.0.1:5179/control`.

Nothing is configured to start with Windows. The managed backend exists only while OBS is running and at least one native leaderboard source is visible.

For a normal installed copy of OBS, its installation drive or folder does not usually matter because the installer uses OBS's recommended global Windows plugin location under `ProgramData`.

### Custom or Portable OBS Installation

The included installer always targets `C:\ProgramData\obs-studio\plugins`. OBS installations that use portable mode do not use that global directory, and some custom installations may require their own plugin directory. In that case:

1. Close OBS.
2. Find the custom or portable OBS root folder. This is the folder containing OBS's `bin`, `data`, and `obs-plugins` directories.
3. Create `<OBS folder>\data\plugins` if it does not already exist.
4. Copy the complete `therun-races-overlay` folder from the extracted release into `<OBS folder>\data\plugins`.
5. Restart that copy of OBS and add **TheRun Race Leaderboard** from the Sources menu.

The resulting layout must remain:

```text
<OBS folder>\data\plugins\therun-races-overlay\
|-- bin\64bit\therun-races-overlay.dll
`-- data\
    |-- locale\
    |-- backend\
    `-- runtime\
```

Do not copy only the DLL. OBS needs the complete folder because the v3.2.3 source also loads its locale files, bundled backend, and Node.js runtime from `data`. See the official [OBS Plugins Guide](https://obsproject.com/kb/plugins-guide) for custom plugin paths.

The source properties provide controls for automatic backend management, a custom backend URL, output width, row height and gaps, title visibility and size, font family and scale, render quality, background opacity, gradient amount, shadow offset/blur/opacity, outline size, and polling interval.

New native sources use this tested starting profile:

- Output width `750`, row height `110`, and row gap `3`.
- Visible title at size `32`, Segoe UI, and `115%` text scale.
- `100%` render quality.
- Runner background opacity `20%` and position background opacity `75%`.
- Gradient strength `100%`.
- Shadow offset `4`, blur `2`, and opacity `100%`.
- Outline size `2.00`.
- Polling interval `1000 ms` and automatic bundled backend startup enabled.

Gradient amount ranges from `0` (solid semantic colors) to `100` (the full white/color/dark treatment). Render quality remains adjustable from `100%` to `300%`, but `100%` is the intentional default for the tested visual style. ELO ratings use solid colors instead of gradients. Existing OBS sources retain their saved values; create a new source or change the controls manually to use this profile.

Higher render-quality values provide additional source pixels for OBS scaling, but the final stream still contains only the pixels available at the source's transformed canvas size. The tested profile deliberately uses `100%`; raise it only when that looks better for a particular scene transform. Avoid shrinking the source far below its configured **Output width**, and use OBS's Lanczos scale filter when substantial downscaling is necessary.

Implementation, build, and installation details are documented in [`OBS-PLUGIN.md`](OBS-PLUGIN.md).

## Release Package

The v3 GitHub release asset is:

```text
release/TheRunRacesOverlay-v3.2.3-OBS-Plugin-Windows-x64.zip
```

The zip contains:

- `therun-races-overlay/` (the native OBS plugin, managed backend, Node.js runtime, and Node.js license)
- `install-obs-plugin.bat`
- `public/`
- `test/`
- `server.js`
- `package.json`
- `start-overlay.bat`
- `start-overlay.ps1`
- `README.md`
- `OBS-PLUGIN.md`
- `CHANGELOG.md`
- `LICENSE`
- `LICENSE-OBS-PLUGIN`
- `NOTICE.md`

Only the complete `therun-races-overlay/` folder is required for native operation. The root `server.js`, `public/`, tests, and start scripts remain in the release for the optional Browser Source fallback and independent verification. Documentation and license notices cover both editions and the bundled Node.js runtime.

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

The control page also contains a diagnostics table. It reports the data currently used for each visible runner, including timing method, completed/planned parent splits, public split-plan status, and whether a race delta is comparable. Diagnostics never appear in the OBS overlay.

## Browser Source Setup

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

- Recognized subsplits are ignored as individual checkpoints. Only a completed parent split group advances race position.
- The overlay reads nested runners' public `.lss` plans so raw totals such as `15` and `62` can still resolve to the same parent-split count.
- Runners with matching parent-split counts are ordered by furthest completed parent split.
- When runners are on the same parent split, whoever reached it first in real-world time stays ahead.
- The `LEADER` label is therefore independent of whether a runner uses IGT, RTA, or another LiveSplit timing method.
- Race deltas still compare the runners' LiveSplit times at the latest parent split both runners have completed. A runner behind the physical leader can correctly show a green negative delta.
- If two runners report different timing methods, such as IGT and RTA, their physical positions remain intact but no numerical delta is shown between them.
- The overlay never compares one runner's completed split time against another runner's live current timer.

After anyone finishes:

- The fastest finished runner becomes the baseline and #1.
- Other finished runners are ordered by final time and keep deltas against the fastest finisher.
- Runners still racing are ordered after finished runners by parent-split progress and real-world arrival time.
- Compatible active runners keep deltas against the fastest finisher at the latest shared parent split.
- Abandoned runners are ordered at the bottom. If multiple runners abandon, the later abandoner ranks above the earlier abandoner, so the first to abandon is last.
- Disqualified runners are placed below abandoned runners with `-` and their disqualification time when available.
- Runners with incompatible split structures remain below the comparable leaderboard with no race delta.

## Display Rules

- `Finished (confirmed)` and `Finished (waiting for confirmation)` replace split text once a runner finishes.
- `Abandoned` replaces split text once a runner abandons; abandoned rows show the abandon time in red when available and do not show confirmation text.
- Disqualified rows show red `Disqualified (reason)` below the runner name and a red disqualification time in the time column.
- `Ready` and `Not Ready` display before a runner has started and before any split has been completed.
- Live runners display their current runner timer in the right column.
- Live runners display their latest completed split below the name as `time at split name`.
- `SPLIT 5/15` beneath the title shows the physical leader's completed parent-split progress.
- A row briefly flashes green when that runner completes a parent split.
- A small red dot before a runner name means TheRun currently reports that runner as streaming.
- ELO rating changes are hidden until TheRun reports a real post-race rating.
- Positive race deltas use red; negative race deltas use green.
- Race deltas use the same font size as the current time and sit close to the current time with a fixed gap.
- Long runner names are clipped so the ELO rating and rating delta stay visible.
- Runner rows are separated by `1.5px` transparent gaps instead of drawn divider lines.
- Position numbers sit on full-height semi-transparent square lanes.
- The race title is centered, uppercase, transparent behind the text, wraps onto extra lines instead of being abbreviated, and can be resized with `TitleFontSize`.
- The row background padding is balanced on both sides, matching the space before the position tile with the space after the current time.
- Participants that TheRun marks `visible: false` are excluded from the leaderboard.
- Overlay text uses an always-on vertical `white -> existing color -> dark gray` gradient, a very thin semi-transparent black outline, and a soft offset black shadow. Row, title, and position backgrounds are not affected.

## Data And Privacy

This tool only makes public `GET` requests to therun.gg pages and TheRun's public split-file CDN. It does not submit race actions, modify races, or require user credentials.

The app prefers TheRun's embedded public race payload when available and falls back to visible page sections when needed. Public `.lss` plans are cached locally in memory and are used only to count parent split groups; subsplits never become leaderboard checkpoints.

If a temporary TheRun request fails after the overlay has already loaded successfully, the local server retains and serves the last successful race snapshot. A small amber dot appears on the overlay until fresh data returns; the control-page diagnostics show the underlying warning.

## Attribution And Licensing

This project is released under the MIT License. See [LICENSE](LICENSE).

See [NOTICE.md](NOTICE.md) for third-party notices.
