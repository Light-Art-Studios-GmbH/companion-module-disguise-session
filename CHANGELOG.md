# Changelog

## 1.2.2 – 2026-10-01

- Fixed: a transport key could show the old state (play mode, engaged, volume, brightness) for up to 10 seconds when
  a session refresh answered just after the key was pressed. While Live Update delivers a transport, the refresh no
  longer overwrites these values.
- Only variables that actually changed are sent to Companion (about 16 instead of 76 values per frame for a playing
  transport) – noticeably lighter on small Companion hosts such as a Raspberry Pi.
- If Designer reports a play-mode code the module does not know, the module keeps the last known mode and logs the
  code once as a warning, so it can be added.

## 1.2.1 – 2026-10-01

- Fixed: after Designer was restarted, Live Update could stay disconnected, so section jumps (next / previous / back /
  forward) were computed from an old playhead and landed on the wrong section, and the time displays stood still.
  The websocket now gives up a connection attempt that is not answered within 5 seconds and retries, subscriptions
  that Designer refuses while a project is loading are retried, and a watchdog resubscribes a transport whose
  playhead does not arrive. After a reconnect the session is re-read.
- Safety: without a live playhead, section jumps use Designer's own next / previous section, and the tools that
  write at the playhead (new layer, paste, fade here, tags, notes, split / merge, crossfade, insert time) refuse to
  run instead of writing at a wrong position.

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
