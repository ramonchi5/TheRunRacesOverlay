# Native OBS Plugin

Version 3.0.2 is a Windows x64 OBS module built against the official OBS Plugin Template. It replaces the Browser Source/CEF rendering layer while continuing to use the existing local Node.js backend for all TheRun parsing and race logic.

## Architecture

```text
therun.gg -> server.js -> http://127.0.0.1:5179/api/race -> native OBS source
```

The source lifecycle is implemented with `obs_source_info`:

- `create` owns settings, worker thread, pending frame, and GPU texture.
- `update` copies source-property values and wakes the worker.
- The worker polls JSON without blocking OBS's render thread.
- GDI+ rasterizes a transparent BGRA frame only when data or settings change.
- `video_render` uploads the newest frame and draws one OBS texture.
- `destroy` joins the worker and releases the texture inside the OBS graphics context.

Temporary backend failures retain the last successful texture. The plugin never places a large connection error over an established leaderboard.

## Text Rendering

- Bold labels use a five-stop vertical gradient measured against each glyph's exact bounds.
- ELO ratings and rating changes use solid colors for small-text clarity.
- Shadows are drawn as a separate multi-sample layer before the glyph fill.
- Outlines are optional and disabled by default.
- Gaps and all areas outside runner bands remain transparent.

## Build

The checked-in build files come from the official OBS Plugin Template. The GitHub workflow builds with Visual Studio 2022 on `windows-2022` and uploads an installable artifact.

For a local build, install Visual Studio 2022 with the Desktop development with C++ workload and CMake 3.30, then run:

```powershell
cmake --preset windows-x64
cmake --build --preset windows-x64 --config RelWithDebInfo
cmake --install build_x64 --prefix release/RelWithDebInfo --config RelWithDebInfo
```

## Install

Copy the generated `therun-races-overlay` folder into:

```text
%APPDATA%\obs-studio\plugins\
```

Restart OBS and add **TheRun Race Leaderboard** from the Sources menu. Start the local backend with `start-overlay.bat`, then paste a race URL into the source properties.

## Licensing

The native plugin and its build scaffolding are GPL-2.0-or-later; see `LICENSE-OBS-PLUGIN`. The Node.js backend and Browser Source remain MIT-licensed under `LICENSE`.
