# Changelog

## 1.2.0 – 2026-09-25

- New action **Project: save and backup** – saves the project and writes a backup, like Alt+W in Designer. Save mode
  _Interactive_ (shows Designer's confirmation, the same as Alt+W) or _Silent_ (the same as Designer's autosave).
- New preset **Save** in the Session group.

## 1.1.1 – 2026-09-20

- Clearer diagnosis when the Director answers small status calls but `/transport/…` responses time out: the log and
  the connection status now point to an MTU problem on the network path.
- Troubleshooting section in the help, README and wiki (MTU test with a non-fragmenting ping, jumbo frames), and
  install notes while the module is not in Companion's official list.

## 1.1.0 – 2026-09-13

- Renamed to **disguise-session** (listed as "Disguise: Session API", default label `d3-session`) to follow the
  naming of the other disguise modules, as suggested by the Companion maintainers. The earlier ids are listed as legacy ids; a
  connection created with a pre-release id may still have to be re-added (Companion 5.0.5 did not migrate a
  developer-folder module).

## 1.0.1 – 2026-09-12

- Fixed: the active transport could flip back to the wrong transport every 10 seconds. Designer's
  `/transport/activetransport` can list several transports; the module now follows the transport shown in the
  Designer GUI (Live Update) and uses the REST list only when it names exactly one transport.

## 1.0.0 – 2026-09-12

First release of **Designer Show Control** (manufacturer Disguise, module id `disguise-designer-show-control`).

- Transports and multitransports: play, stop, play to end of section, loop section, return to start, next /
  previous section and track, relative section jumps, go to section / cue / note / tag / time / track / timecode,
  engage, volume and brightness (also on rotary knobs).
- Frame-accurate variables per transport (playhead, section, next section, cues, incoming timecode), feedbacks for
  play state, section, cue, warnings, timecode, master output, machine health and host roles.
- Master fade up / down / hold and fade duration.
- Machine health with acknowledgeable alerts; Director + backup host with automatic follow; failover replace /
  restore that also works after the Director has left the session; default matrix routing.
- Editor host: send commands to the editor, lock to Director / independent playback.
- Layer tools on the active transport: new layers of any module type, clipboard of the GUI selection, fit to
  content, opacity keyframes, blend mode, mapping, play mode, at-end-point, section split / merge / crossfade,
  tags, notes, insert / remove time.
- Designer notes: append lines to note lists or track notes with time / section / track prefixes.
- Companion 5 layered presets for all of the above.
- Configuration: Director, backup, editor, follow, port, warning threshold, cue cache. Connections created with
  the pre-release id `disguise-api` are migrated.
