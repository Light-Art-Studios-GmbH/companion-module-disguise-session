# companion-module-disguise-session

**Disguise: Session API** – Bitfocus Companion connection module for **disguise Designer** (module id `disguise-session`,
project name _Designer Show Control_). It talks to the session API of the
Director (REST on port 80 plus the Live Update websocket) instead of OSC, so Companion sees the real
transport state, sections, cues and machine health and can control everything a Designer operator
would reach for during a show.

- Transports and multitransports: play, stop, play to end of section, loop section, return to start,
  next/previous section and track, relative section jumps ("one section back" that really goes back),
  go to section, cue, note, tag, track or timecode, engage, volume and brightness.
- Frame-accurate variables per transport: playhead and section time as `HH:MM:SS:FF` and single digits,
  current and next section, current and next cue, incoming timecode.
- Master fade up / down / hold, timecode source and matching indicator, warnings before the end of a
  section or track.
- Machine health per machine with acknowledgeable alerts, Director + backup host with automatic follow,
  failover replace / restore that also works when the Director is already gone.
- Layer tools on the active transport: new layers of any module type, copy / cut / paste / duplicate of
  the GUI selection, fit to content, opacity keyframes, blend mode, mapping, play mode, section split /
  merge / crossfade, tags, notes and insert / remove time.
- Companion 5 layered presets (header / value / footer tiles) for all of the above.

Developed and maintained by **Lucas Hoyer, Light Art Studios GmbH** (<lh@lightartstudios.de>).
Licensed under MIT.

User documentation lives in [companion/HELP.md](companion/HELP.md) and is shown inside Companion via
the connection's help button.
A longer tour of every feature is in the
[wiki](https://github.com/Light-Art-Studios-GmbH/companion-module-disguise-session/wiki).

---

## Contents

1. [Requirements](#requirements)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Architecture](#architecture)
5. [Development](#development)
6. [Troubleshooting](#troubleshooting)

---

## Requirements

|           |                                                                                   |
| --------- | --------------------------------------------------------------------------------- |
| Companion | 5.0 or newer (module API `@companion-module/base` 2.x, Node 22 runtime)           |
| disguise  | Designer r30 or newer with the session API enabled (verified against r34.0.3)     |
| Network   | Companion must reach the Director (and optional backup / editor) on the HTTP port |

## Installation

Install the module from Companion's module store, or drop the packaged module into Companion's
developer modules folder (`npm run package` builds it into `pkg/`).

## Configuration

| Field                        | Default | Meaning                                                                                     |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| Director IP / hostname       | –       | The machine running Designer as Director.                                                   |
| Understudy / backup Director | –       | Optional second machine; with _Follow the Director_ commands move to whichever is Director. |
| Editor                       | –       | Optional editor of the session; selected with the _Connection: use host_ action or tile.    |
| Follow the Director          | on      | Switch to the machine that reports itself as Director (and back).                           |
| HTTP port                    | 80      | Port of the session API.                                                                    |
| Warning threshold            | 10 s    | The "remaining" tiles turn orange this many seconds before the next section / end of track. |
| Read the cues of all tracks  | on      | Needed for _Go to cue_ across tracks.                                                       |

The Live Update interval (40 ms), the session refresh (10 s) and the timecode frame rate (taken from the transport) are fixed.

## Architecture

```
src/main.mjs          ESM entry: default export = connection class, named export UpgradeScripts
src/instance.js       DisguiseInstance – hosts, session state, variables, all command helpers
src/api.js            DisguiseApi – session REST client (transport, status, failover)
src/liveupdate.js     LiveUpdate websocket client, role probe, Python property expressions
src/actions.js        action definitions
src/feedbacks.js      feedback definitions
src/variables.js      variable definitions (per transport, per machine, global)
src/presets.js        Companion 5 layered presets
src/cuelist.js        section / cue lookup (pure)
src/timecode.js       timecode formatting and parsing (pure)
src/config.js         connection configuration fields
src/upgrades.js       upgrade scripts
```

REST answers structure and executes transport commands; the Live Update websocket delivers the running
playhead and executes Designer-side edits as one-shot Python expressions. Commands are sent to the host
currently selected (Director, backup or editor); the host roles are probed every few seconds.

## Development

```bash
npm install
npm test           # pure logic (timecode, cuelist)
npm run lint
npm run format
npm run deploy     # rsync into Companion's developer modules folder (override with COMPANION_DEV_MODULES)
npm run package    # companion-module-build → pkg/
```

Integration checks against a real Director live in `scripts/` (`director-check`, `editor-check`,
`layer-fx-check`, `layer-assign-check`, `track-edit-check`); they move the playhead and edit the track
of the test project. Icons are drawn by `scripts/draw-icons.py` (Pillow) and embedded with `npm run icons`.

## Troubleshooting

- **Connection stays red** – the session API only answers while Designer is running on the Director; check
  `http://<director>/api/session/status/project` in a browser.
- **Variables do not move** – the Live Update websocket is blocked or Designer is an Actor; the log shows
  "Live Update connected" when it works.
- **Failover tiles missing** – the Director lists no understudy targets; after a replace, restart the
  understudy and check its role in the Director's d3Net manager.
