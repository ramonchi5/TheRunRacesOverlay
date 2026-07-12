# Third-Party Notices

The Node.js backend and Browser Source frontend are original MIT-licensed code. The optional native OBS source is a separate GPL-2.0-or-later component because it links to OBS Studio's `libobs`.

## therun.gg

The overlay reads public race and runner pages from [therun.gg](https://therun.gg), plus associated public `.lss` split files, and displays derived race information locally in OBS.

TheRun, therun.gg, race data, site content, names, logos, and trademarks belong to their respective owners. This project is not affiliated with, endorsed by, or sponsored by therun.gg.

No therun.gg source code or private API is included in this repository. Users are responsible for using this tool in a way that respects therun.gg's terms, policies, and community expectations.

## Node.js

Node.js is required to run the local server, but it is not bundled in this repository. Node.js and its dependencies are distributed under their own licenses by the Node.js project.

## OBS Studio

OBS Studio hosts both the Browser Source and the optional native source. OBS Studio is not bundled in this repository and is distributed by the OBS Project under GPL-2.0-or-later.

The native source build infrastructure under `cmake/` and `.github/` is adapted from the official [OBS Plugin Template](https://github.com/obsproject/obs-plugintemplate), distributed under GPL-2.0. Its complete license is included as `LICENSE-OBS-PLUGIN`.

The native source code under `src/`, its locale data under `data/`, and resulting plugin binaries are distributed under GPL-2.0-or-later. The existing Node.js and browser overlay remain under the repository's MIT `LICENSE`.

## Implementation Notes

The race logic, Browser Source frontend, native renderer, and backend client were written for this repository. The native build scaffolding is derived from the official OBS Plugin Template as described above; no OBS Studio implementation source is included.
