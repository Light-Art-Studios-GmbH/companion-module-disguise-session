## Disguise: Session API – Designer Show Control

Controls a **disguise Designer** session through its session API: REST on the Director for commands and
structure, the Live Update websocket for the running playhead and for Designer-side edits. No authentication is
needed; the session API only answers while Designer is running.

Developed by Lucas Hoyer, Light Art Studios GmbH (lh@lightartstudios.de).

### Setup

1. Add the connection **Disguise: Session API** and enter the IP or hostname of the **Director**.
2. Optionally enter the **Understudy / backup Director** and an **Editor** of the same session.
3. Save. The connection status shows the machine it talks to and the Designer version.

| Field                        | Default | Meaning                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Director IP / hostname       | –       | The machine running Designer as Director.                                                         |
| Understudy / backup Director | –       | Second machine of the session; with _Follow the Director_ commands move to whichever is Director. |
| Editor                       | –       | Editor of the session; selected with the _Connection: use host_ action or the Editor tiles.       |
| Follow the Director          | on      | Switch to the machine that reports itself as Director, and back.                                  |
| HTTP port                    | 80      | Port of the session API.                                                                          |
| Warning threshold            | 10 s    | The "remaining" tiles turn orange this many seconds before the next section / end of track.       |
| Read the cues of all tracks  | on      | Needed for _Go to cue_ across tracks.                                                             |

The timecode frame rate follows the transport (its timecode format, else the project refresh rate).

### Transports

Every transport action and feedback has a **Transport** option: the _active transport_ (whatever is active in
Designer), _all transports_, one transport, one **multitransport** (the command goes to all its members) or a typed
name (`$(…)` variables work in expression mode).

Actions: play, stop, play to end of section, loop section, return to start, play / stop toggle, next / previous
section and track, engage / disengage, volume and brightness (set or adjust, also on rotary knobs).

### Sections, cues and timecode

- **Jump sections (relative)** jumps to the _start_ of the section `delta` sections away: `-1` is a real "back"
  key (start of the previous section wherever the playhead is), `0` restarts the current section, `+1` is the
  next section.
- **Go to cue / note / tag / section by text** searches the cue, MIDI and timecode tags, the notes and the section
  names of the current track and jumps there. Numbers are compared numerically (`1` finds a `1.00` cue). With
  _Also search the other tracks_ the transport switches track first.
- **Go to timecode** uses Designer's own `gototimecode` (`HH:MM:SS:FF`). The _Transport timecode input_ tiles show
  the incoming timecode, its source and whether the transport is locked to it.

### Master output

_Master: fade down / fade up / hold_ switches Designer's master output using the project's fade duration;
_Master: set fade duration_ changes it. The master tile toggles between fade up and fade down and shows the state.

### Machines and failover

Each machine of the session has health variables (`m_<machine>_…`: role, state, problems, fps, dropped frames,
alerts) and a health tile that turns red on dropped frames, non-ready states or notifications. Pressing the tile
(_Machine: acknowledge alerts_) clears the indication until something new happens.

**Failover replace / restore** target the machine that is replaced by its understudy (one tile per understudy
pair, e.g. "Replace DIRECTOR by UNDERSTUDY"). The request is sent to every configured host at once; if Designer refuses
because the machine has already left the session, the module runs Designer's internal replace / restore command
on the backup host – the same as the buttons in the d3Net manager. After a replace, restart the understudy once
the Director is back so that it registers as understudy again.

With _Follow the Director_ the commands and the live data move to the backup host when the Director goes away and
back when it returns. _Connection: use host_ selects a host by hand.

### Editor

Enter an editor of the session as **Editor**. The _Send commands to Editor_ / _Send commands to Director_ tiles
choose where commands and the live data come from; following the Director is paused while the editor is
selected. _Editor: lock to Director / independent playback_ always addresses the editor and the toggle tile shows
its current mode. The layer selection used by the layer tools is the one of the Designer GUI on the host the
commands go to.

### Layers (active transport only)

Layer commands address the active transport, the one visible in Designer. They run as one-shot Python
expressions through Live Update; there is no undo.

- **New layers**: _Layer: add new layer at the playhead_ creates a layer of any Designer module type (Video,
  Colour, Bitmap, Notch, …) on the current track, starting at the playhead with a length in seconds or until the
  next section. Layers can also be duplicated, enabled / disabled, moved / resized and removed by name.
- **Layer clipboard**: _duplicate / copy / cut / paste the selection_ works on the layers selected in the Designer
  GUI. Copy remembers them and paste duplicates them at the playhead; cut remembers them and paste moves them.
- **Selected layer**: _Fit to content_ sets the layer length to the clip length; _Keyframe fade_ writes opacity
  keyframes (from / to value, duration, anchored at the start, the end or the playhead); _Clear keyframes_ removes
  them; _Blend mode_, _Mapping_, _Play mode_ (Normal / Locked) and _At end point_ (Loop / Ping-pong / Pause) assign
  those settings; _Assign any field_ writes a static value into any layer field.
- **Sections, tags, time**: _Section: split / merge at the playhead_, _Section: crossfade_ (undefined, or fade
  with duration and loop crossfade for the section the playhead is in), _Track: add tag / note at the playhead_
  (cue, MIDI or timecode tag, or a note) and _Track: insert / remove time_ (moving, stretching or leaving the
  layers).

### Notes

_Notes: add a line_ appends a paragraph to a Designer note list (the Notes widget) or to the note of a track,
optionally prefixed with the transport time, section, track, time of day or date. The _Take note_ tile writes to
the note of the current track; the target and prefixes are chosen in the action.

### Feedbacks

Play mode, playing, engaged, current track / section / cue, next section / cue, _remaining below_ warnings
(blinking), timecode matching and source, master output, machine health, host states (Director / backup / editor),
editor lock, receiving timecode and dropped frames.

### Variables

Every transport, every multitransport and the active transport (`active_…`) provide the same set, prefixed with a
key derived from the name (`default_…`, `imag_screens_…`):

| Variable                                                                              | Meaning                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `playmode`, `playing`, `engaged`                                                      | Play mode (Play, PlaySection, Loop, Stop) and states |
| `track`                                                                               | Current track                                        |
| `time_tc`, `time_seconds`, `time_hh/mm/ss/ff`                                         | Playhead                                             |
| `track_remaining_tc`                                                                  | Time to the end of the track                         |
| `section_index`, `section_label`                                                      | Current section                                      |
| `section_elapsed_tc`                                                                  | Elapsed in the section                               |
| `section_remaining_tc`, `_seconds`, `_hh/mm/ss/ff`                                    | Remaining to the next section                        |
| `next_section_index`, `next_section_label`                                            | Next section                                         |
| `cue_current`, `cue_next`, `cue_next_remaining_tc`                                    | Current and next cue (tag or note)                   |
| `note_current`, `tag_current`                                                         | Last note / tag before the playhead                  |
| `volume`, `brightness`                                                                | Levels in percent                                    |
| `fps`, `tc_status`, `tc_source`, `tc_incoming`, `tc_incoming_hh/mm/ss/ff`, `tc_match` | Timecode                                             |

Global: `connected`, `project`, `designer_version`, `session_mode`, `director`, `active_transport`, `active_host`,
`active_machine`, `primary_host` / `primary_state`, `backup_host` / `backup_state`, `editor_host` / `editor_state`,
`editor_lock`, `selected_layers`, `master_output`, `fade_duration`, `failover_preset`, `dropped_frames`.

### Presets

_Session / Director_ (status, where commands go, Director and backup host, master fade), _Editor_, _Machines_
(health per machine, failover replace / restore per understudy pair, default routing), _Active transport_
(control, displays and warnings, big digits, timecode input, cues and jumps, volume and brightness, new layers,
layer clipboard, selected layer, sections / tags / time, take note), one control group per multitransport and one
full group per transport.

### Troubleshooting

**The module is not in Companion's module list** – it has not been added to the official list yet. Until then, add it
through Companion's developer modules folder or import the package from the GitHub release.

**Timeout on `/transport/…` although the Director is reachable** (status "Director reachable, large responses time
out – check MTU"). The module reaches the Director, but larger answers never arrive. Small responses (project, session status) fit
into one network packet; the transport and track lists do not. If the network path cannot carry packets of the
configured MTU size, exactly these larger responses are lost – it looks like a hanging API, but it is an MTU
problem. Test it from the Companion machine with a ping that must not be fragmented:

```
macOS:    ping -D -s 1472 <director-ip>
Linux:    ping -M do -s 1472 <director-ip>
Windows:  ping -f -l 1472 <director-ip>
```

1472 bytes of payload make a full 1500-byte packet. If this ping fails while a smaller one (for example 1400)
works, the path does not carry the MTU your interface is set to. Set the MTU consistently on all devices in the
path – Companion machine, switches, Director. Enabling jumbo frames along the whole path can help as well;
otherwise lower the MTU on the Companion machine's interface until the ping passes.
