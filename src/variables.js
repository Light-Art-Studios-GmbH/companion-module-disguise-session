/**
 * @file Variable definitions.
 *
 * Every transport, every multitransport and the active transport ("active") get the same set of variables,
 * prefixed with a key derived from the name ("IMAG Screens" → imag_screens_…). Definitions are rebuilt when the
 * session's transports change (see DisguiseInstance.rebuildDefinitions).
 */

/** [id, description] per transport; published by DisguiseInstance.publishTransport(). */
const TRANSPORT_VARS = [
	['playmode', 'Play mode (Play, PlaySection, Loop, Stop)'],
	['playing', 'Playing (true/false)'],
	['engaged', 'Engaged (true/false)'],
	['track', 'Current track'],
	['time_tc', 'Playhead (HH:MM:SS:FF)'],
	['time_seconds', 'Playhead (seconds)'],
	['time_hh', 'Playhead: hours'],
	['time_mm', 'Playhead: minutes'],
	['time_ss', 'Playhead: seconds'],
	['time_ff', 'Playhead: frames'],
	['track_remaining_tc', 'Time to end of track (HH:MM:SS:FF)'],
	['section_index', 'Current section number'],
	['section_label', 'Current section (name or "Section N")'],
	['section_elapsed_tc', 'Elapsed in section (HH:MM:SS:FF)'],
	['section_remaining_tc', 'Remaining to next section (HH:MM:SS:FF)'],
	['section_remaining_seconds', 'Remaining to next section (seconds)'],
	['section_remaining_hh', 'Remaining to next section: hours'],
	['section_remaining_mm', 'Remaining to next section: minutes'],
	['section_remaining_ss', 'Remaining to next section: seconds'],
	['section_remaining_ff', 'Remaining to next section: frames'],
	['next_section_index', 'Next section number'],
	['next_section_label', 'Next section (name or "Section N")'],
	['cue_current', 'Current cue (last tag or note before the playhead)'],
	['cue_next', 'Next cue (next tag or note)'],
	['cue_next_remaining_tc', 'Remaining to next cue (HH:MM:SS:FF)'],
	['note_current', 'Current note (last note before the playhead)'],
	['tag_current', 'Current tag (last tag before the playhead)'],
	['volume', 'Volume (0–100 %)'],
	['brightness', 'Brightness (0–100 %)'],
	['fps', 'Timecode frame rate'],
	['tc_status', 'Timecode status text'],
	['tc_source', 'Timecode source type (MTC, LTC, … or empty)'],
	['tc_incoming', 'Incoming timecode (as the source sends it)'],
	['tc_incoming_hh', 'Incoming timecode: hours'],
	['tc_incoming_mm', 'Incoming timecode: minutes'],
	['tc_incoming_ss', 'Incoming timecode: seconds'],
	['tc_incoming_ff', 'Incoming timecode: frames'],
	['tc_match', 'Timecode match (receiving / no timecode)'],
]

/** [id, description] per machine of the session (health), prefixed with m_<machine>_. */
const MACHINE_VARS = [
	['role', 'Role (director / understudy / actor)'],
	['state', 'Worst state (ready / warning / error …)'],
	['problems', 'States that are not ready (name: detail, …)'],
	['fps', 'Render fps'],
	['dropped_frames', 'Dropped video frames'],
	['notifications', 'Number of notifications'],
	['alerts', 'Unacknowledged problems and notifications (text)'],
	['alert_count', 'Number of unacknowledged alerts'],
]

const GLOBAL_VARS = {
	connected: { name: 'Connected to the session (true/false)' },
	project: { name: 'Project name' },
	designer_version: { name: 'Designer version' },
	session_mode: { name: 'Session (Solo / Director + actors)' },
	director: { name: 'Machine that currently is the Director' },
	active_transport: { name: 'Name of the active transport' },
	active_host: { name: 'Host the commands go to' },
	active_machine: { name: 'Machine answering on that host' },
	primary_host: { name: 'Configured Director host' },
	primary_state: { name: 'State of the Director host (director / understudy / actor / offline)' },
	backup_host: { name: 'Configured backup host' },
	backup_state: { name: 'State of the backup host (director / understudy / actor / offline / not configured)' },
	editor_host: { name: 'Configured editor host' },
	editor_state: { name: 'State of the editor host (editor / online / offline / not configured)' },
	editor_lock: { name: 'Editor transport mode (locked to Director / independent)' },
	selected_layers: { name: 'Layers selected in the Designer GUI (comma separated)' },
	master_output: { name: 'Master output (Fade up / Fade down / Hold)' },
	fade_duration: { name: 'Master fade duration (seconds)' },
	failover_preset: { name: 'Failover matrix preset currently applied' },
	dropped_frames: { name: 'Dropped video frames (all machines)' },
}

/**
 * @param {string} key variable prefix
 * @param {string} label human readable owner ("Transport default")
 */
function transportVariableDefs(key, label) {
	/** @type {Record<string, {name:string}>} */
	const defs = {}
	for (const [id, desc] of TRANSPORT_VARS) defs[`${key}_${id}`] = { name: `${label}: ${desc}` }
	return defs
}

/**
 * @param {string} key machine key
 * @param {string} label machine name
 */
function machineVariableDefs(key, label) {
	/** @type {Record<string, {name:string}>} */
	const defs = {}
	for (const [id, desc] of MACHINE_VARS) defs[`m_${key}_${id}`] = { name: `Machine "${label}": ${desc}` }
	return defs
}

/**
 * @param {{variableTargets: () => {key:string, label:string}[], machineTargets: () => {key:string, name:string}[]}} instance
 */
function getVariableDefinitions(instance) {
	let defs = { ...GLOBAL_VARS }
	for (const t of instance.variableTargets()) defs = { ...defs, ...transportVariableDefs(t.key, t.label) }
	for (const m of instance.machineTargets()) defs = { ...defs, ...machineVariableDefs(m.key, m.name) }
	return defs
}

module.exports = {
	TRANSPORT_VARS,
	MACHINE_VARS,
	GLOBAL_VARS,
	transportVariableDefs,
	machineVariableDefs,
	getVariableDefinitions,
}
