# Native OBS Plugin

Version 3.2.3 is a Windows x64 OBS module built against the official OBS Plugin Template. It replaces the Browser Source/CEF rendering layer and automatically manages a bundled copy of the existing Node.js backend for all TheRun parsing and race logic.

## Architecture

```text
therun.gg -> bundled server.js -> http://127.0.0.1:5179/api/race -> native OBS source
```

The source lifecycle is implemented with `obs_source_info`:

- `create` owns settings, worker thread, pending frame, and GPU texture.
- `update` copies source-property values and wakes the worker.
- `show` acquires the shared managed backend; `hide` releases it and pauses polling.
- The first visible source launches one hidden bundled Node.js process, and the last hidden source stops it.
- The worker polls JSON without blocking OBS's render thread.
- GDI+ rasterizes a supersampled premultiplied-BGRA frame when race data or settings change.
- `video_render` uploads the newest frame and draws one texture at the source's stable logical size.
- `destroy` joins the worker and releases the texture inside the OBS graphics context.

Temporary backend failures retain the last successful texture. The plugin never places a large connection error over an established leaderboard.

## Text Rendering

- Bold labels use a smooth distance-controlled vertical gradient measured against each glyph's exact bounds.
- Gradient bounds extend beyond the glyph edge so endpoint colors cannot wrap onto the bottom row of antialiased pixels.
- Gradient amount `0` uses solid semantic colors; higher values extend the light/dark transitions inward while preserving the semantic color at the center.
- ELO ratings and rating changes use solid colors for small-text clarity.
- Shadows are drawn as a separate multi-sample layer before the glyph fill.
- Outlines are optional and disabled by default.
- Render quality defaults to `200%`; premultiplied-alpha sampling prevents bright transparent-edge contamination during OBS scaling.
- Equal outer gutters, row gaps, and all areas outside runner bands remain transparent.

## Build

The checked-in build files come from the official OBS Plugin Template. The GitHub workflow builds with Visual Studio 2022 on `windows-2022` and uploads an installable artifact.

For a local build, use Visual Studio 2022 or newer with the **Desktop development with C++** workload. Include the MSVC x64/x86 build tools, Windows 11 SDK, CMake tools for Windows (CMake 3.30 or newer), and a Node.js executable to package, then run:

```powershell
cmake --preset windows-x64
cmake --build --preset windows-x64 --config RelWithDebInfo
cmake --install build_x64 --prefix release/RelWithDebInfo --config RelWithDebInfo
```

The local preset lets CMake select the newest installed Visual Studio generator and Windows SDK. The CI preset remains pinned to Visual Studio 2022 for GitHub's `windows-2022` runner.

## Install

The v3 release includes `install-obs-plugin.bat`. It copies the complete generated `therun-races-overlay` folder into OBS's recommended Windows plugin directory:

```text
C:\ProgramData\obs-studio\plugins\
```

The plugin remains installed after reboot. Restart OBS, add **TheRun Race Leaderboard** from the Sources menu, and paste a race URL into the source properties. The bundled backend starts automatically with no console window whenever the source is shown.

The DLL cannot be installed by itself because OBS also loads locale data, the race backend, and the bundled runtime from the plugin folder. The ProgramData path is independent of a standard OBS installation path. For portable OBS, copy the complete folder into that installation's configured plugin directory instead.

## Licensing

The native plugin and its build scaffolding are GPL-2.0-or-later; see `LICENSE-OBS-PLUGIN`. The Node.js backend and Browser Source remain MIT-licensed under `LICENSE`. The bundled Node.js runtime is distributed under the notices included at `data/runtime/LICENSE`.
