/**
 * @file Feedback definitions (all boolean).
 *
 * Feedbacks on a multitransport evaluate its members: "playing" is true when any member plays,
 * the others when all members agree.
 */
const { combineRgb } = require('@companion-module/base')
const { textMatches } = require('./cuelist.js')
const { transportOption, machineOption, MATCH_CHOICES } = require('./actions.js')

const GREEN = combineRgb(0, 150, 0)
const RED = combineRgb(200, 0, 0)
const BLUE = combineRgb(0, 90, 200)
const AMBER = combineRgb(226, 166, 61)
const ORANGE = combineRgb(239, 143, 82)
const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)

/**
 * @param {import('./instance.js').DisguiseInstance} instance
 * @returns {import('@companion-module/base').CompanionFeedbackDefinitions}
 */
function getFeedbackDefinitions(instance) {
	const T = () => transportOption(instance)
	const every = (opt, pred) => {
		const targets = instance.resolveTargets(opt)
		return targets.length > 0 && targets.every(pred)
	}
	const some = (opt, pred) => instance.resolveTargets(opt).some(pred)
	const matchOption = { id: 'match', type: 'dropdown', label: 'Match', default: 'exact', choices: MATCH_CHOICES }

	return {
		connected: {
			type: 'boolean',
			name: 'Director connected',
			description: 'True while the session API answers',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => instance.session.connected,
		},
		playmode: {
			type: 'boolean',
			name: 'Play mode is',
			description: 'True while the transport is in the selected play mode',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				T(),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Play mode',
					default: 'Play',
					choices: [
						{ id: 'Play', label: 'Play' },
						{ id: 'PlaySection', label: 'Play to end of section' },
						{ id: 'Loop', label: 'Loop section' },
						{ id: 'Stop', label: 'Stop' },
					],
				},
			],
			callback: (fb) => every(fb.options.transport, (t) => t.playmode === fb.options.mode),
		},
		playing: {
			type: 'boolean',
			name: 'Playing',
			description: 'True while the playhead is running (any play mode)',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [T()],
			callback: (fb) => some(fb.options.transport, (t) => t.playing),
		},
		engaged: {
			type: 'boolean',
			name: 'Engaged',
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [T()],
			callback: (fb) => every(fb.options.transport, (t) => t.engaged),
		},
		track_is: {
			type: 'boolean',
			name: 'Current track is',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{
					id: 'track',
					type: 'dropdown',
					label: 'Track (pick or type a name)',
					default: '',
					choices: instance.trackChoices(),
					allowCustom: true,
					minChoicesForSearch: 0,
				},
			],
			callback: (fb) => {
				const want = String(fb.options.track ?? '').trim()
				if (!want) return false
				return every(fb.options.transport, (t) => t.trackUid === want || textMatches(t.trackName, want, 'exact'))
			},
		},
		section_is: {
			type: 'boolean',
			name: 'Current section is',
			description: 'Compares the section index (0, 1, 2 …) or the section name',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{ id: 'section', type: 'textinput', label: 'Section index or name', default: '1', useVariables: true },
				matchOption,
			],
			callback: (fb) =>
				every(fb.options.transport, (t) => {
					const sec = instance.derived(t).section
					return !!sec && sectionMatches(sec, fb.options.section, fb.options.match)
				}),
		},
		next_section_is: {
			type: 'boolean',
			name: 'Next section is',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{ id: 'section', type: 'textinput', label: 'Section index or name', default: '2', useVariables: true },
				matchOption,
			],
			callback: (fb) =>
				every(fb.options.transport, (t) => {
					const sec = instance.derived(t).next
					return !!sec && sectionMatches(sec, fb.options.section, fb.options.match)
				}),
		},
		cue_is: {
			type: 'boolean',
			name: 'Current cue is',
			description: 'The last tag (cue number) or note before the playhead matches',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{ id: 'text', type: 'textinput', label: 'Cue number or note text', default: '', useVariables: true },
				matchOption,
			],
			callback: (fb) =>
				every(fb.options.transport, (t) => {
					const cue = instance.derived(t).cueCurrent
					return !!cue && cueMatches(cue, fb.options.text, fb.options.match)
				}),
		},
		next_cue_is: {
			type: 'boolean',
			name: 'Next cue is',
			description: 'The next tag (cue number) or note after the playhead matches',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{ id: 'text', type: 'textinput', label: 'Cue number or note text', default: '', useVariables: true },
				matchOption,
			],
			callback: (fb) =>
				every(fb.options.transport, (t) => {
					const cue = instance.derived(t).cueNext
					return !!cue && cueMatches(cue, fb.options.text, fb.options.match)
				}),
		},
		remaining_below: {
			type: 'boolean',
			name: 'Warning: next section in less than',
			description: 'True during the last seconds before the next section starts. Optionally blinks (2 Hz).',
			defaultStyle: { bgcolor: ORANGE, color: BLACK },
			options: [
				T(),
				{ id: 'seconds', type: 'number', label: 'Seconds', default: 10, min: 0, max: 36000 },
				{ id: 'onlyPlaying', type: 'checkbox', label: 'Only while playing', default: true },
				{ id: 'needNext', type: 'checkbox', label: 'Only when a next section exists', default: true },
				{ id: 'blink', type: 'checkbox', label: 'Blink', default: false },
			],
			callback: (fb) => {
				const active = some(fb.options.transport, (t) => {
					const d = instance.derived(t)
					if (fb.options.onlyPlaying && !t.playing) return false
					if (fb.options.needNext && !d.next) return false
					return d.remaining <= Number(fb.options.seconds)
				})
				return active && (!fb.options.blink || instance.blinkOn)
			},
		},
		track_remaining_below: {
			type: 'boolean',
			name: 'Warning: end of track in less than',
			description: 'True during the last seconds before the end of the track. Optionally blinks (2 Hz).',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				T(),
				{ id: 'seconds', type: 'number', label: 'Seconds', default: 10, min: 0, max: 36000 },
				{ id: 'onlyPlaying', type: 'checkbox', label: 'Only while playing', default: true },
				{ id: 'blink', type: 'checkbox', label: 'Blink', default: false },
			],
			callback: (fb) => {
				const active = some(fb.options.transport, (t) => {
					const d = instance.derived(t)
					if (fb.options.onlyPlaying && !t.playing) return false
					return d.trackRemaining <= Number(fb.options.seconds)
				})
				return active && (!fb.options.blink || instance.blinkOn)
			},
		},
		timecode_matching: {
			type: 'boolean',
			name: 'Timecode matching (transport follows the incoming timecode)',
			description: 'True when Designer\'s timecode status is neither stopped nor "no matching timecode"',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [T()],
			callback: (fb) => some(fb.options.transport, (t) => instance.timecodeMatching(t)),
		},
		tc_source_is: {
			type: 'boolean',
			name: 'Timecode source is',
			description: 'Compares the timecode source of the transport (mtc, ltc, …)',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [
				T(),
				{
					id: 'source',
					type: 'textinput',
					label: 'Source (e.g. mtc, ltc; empty = any source)',
					default: '',
					useVariables: true,
				},
			],
			callback: (fb) => {
				const want = String(fb.options.source ?? '')
					.trim()
					.toLowerCase()
				return some(fb.options.transport, (t) => (want ? t.tcSource.toLowerCase() === want : !!t.tcSource))
			},
		},
		master_output: {
			type: 'boolean',
			name: 'Master output is',
			description: "Designer's master output state (fade down / fade up / hold)",
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'State',
					default: 'fadedown',
					choices: [
						{ id: 'fadedown', label: 'Fade down (black)' },
						{ id: 'fadeup', label: 'Fade up' },
						{ id: 'hold', label: 'Hold' },
					],
				},
			],
			callback: (fb) => ({ fadedown: 0, fadeup: 1, hold: 2 })[String(fb.options.mode)] === instance.master.output,
		},
		machine_health: {
			type: 'boolean',
			name: 'Machine alert (dropped frames, states, notifications)',
			description:
				'True when the machine reports something new since the last acknowledge: dropped frames, a non-ready state, a notification or a low frame rate. The action "Machine: acknowledge alerts" clears it.',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				machineOption(instance),
				{ id: 'dropped', type: 'checkbox', label: 'Dropped frames', default: true },
				{ id: 'states', type: 'checkbox', label: 'States not "ready"', default: true },
				{ id: 'notifications', type: 'checkbox', label: 'Notifications', default: true },
				{ id: 'minFps', type: 'number', label: 'Frame rate below (0 = ignore)', default: 0, min: 0, max: 1000 },
				{ id: 'ignoreAck', type: 'checkbox', label: 'Ignore acknowledgements (always show)', default: false },
			],
			callback: (fb) => {
				const m = instance.resolveMachine(fb.options.machine)
				if (!m) return false
				const a = instance.machineAlerts(m, !!fb.options.ignoreAck)
				if (fb.options.dropped && a.dropped > 0) return true
				if (fb.options.states && a.states.length > 0) return true
				if (fb.options.notifications && a.notifications.length > 0) return true
				const min = Number(fb.options.minFps) || 0
				return min > 0 && m.fps > 0 && m.fps < min
			},
		},
		host_state: {
			type: 'boolean',
			name: 'Host state is',
			description: 'State of the configured Director or backup host',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{
					id: 'which',
					type: 'dropdown',
					label: 'Host',
					default: 'primary',
					choices: [
						{ id: 'primary', label: 'Director host' },
						{ id: 'backup', label: 'Backup host' },
						{ id: 'editor', label: 'Editor host' },
					],
				},
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'director',
					choices: [
						{ id: 'director', label: 'Is the Director' },
						{ id: 'editor', label: 'Is an editor' },
						{ id: 'understudy', label: 'Online, not the Director' },
						{ id: 'online', label: 'Reachable (any role)' },
						{ id: 'offline', label: 'Offline' },
					],
				},
			],
			callback: (fb) => {
				const h = instance.hostByKey(fb.options.which)
				if (!h?.host) return fb.options.state === 'offline'
				switch (fb.options.state) {
					case 'director':
						return h.reachable && h.isDirector
					case 'editor':
						return h.reachable && h.state === 'editor'
					case 'understudy':
						return h.reachable && !h.isDirector
					case 'online':
						return h.reachable
					default:
						return !h.reachable
				}
			},
		},
		editor_locked: {
			type: 'boolean',
			name: 'Editor: locked to Director',
			description: 'True while the configured editor follows the Director (false = independent playback)',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () =>
				!!instance.editorTarget?.host && instance.editorTarget.state !== 'director' && instance.editorLocked,
		},
		on_editor: {
			type: 'boolean',
			name: 'Commands go to the editor host',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [],
			callback: () => instance.activeHostKey === 'editor',
		},
		on_backup: {
			type: 'boolean',
			name: 'Commands go to the backup host',
			defaultStyle: { bgcolor: ORANGE, color: BLACK },
			options: [],
			callback: () => instance.activeHostKey === 'backup',
		},
		receiving_timecode: {
			type: 'boolean',
			name: 'Receiving timecode',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [T()],
			callback: (fb) => some(fb.options.transport, (t) => t.receivingTimecode),
		},
		dropped_frames: {
			type: 'boolean',
			name: 'Dropped frames (health)',
			description: 'True when any machine of the session reports dropped video frames',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => instance.health.dropped > 0,
		},
	}
}

/** @param {{index?:string, name?:string}} sec */
function sectionMatches(sec, want, mode) {
	const w = String(want ?? '').trim()
	if (!w) return false
	if (/^\d+$/.test(w) && Number(sec.index) === Number(w)) return true
	return textMatches(sec.index ?? '', w, 'exact') || (!!sec.name && textMatches(sec.name, w, mode || 'exact'))
}

/** @param {{text:string}} cue */
function cueMatches(cue, want, mode) {
	const w = String(want ?? '').trim()
	if (!w) return false
	if (/^[+-]?\d+(\.\d+)?$/.test(w) && /^[+-]?\d+(\.\d+)?$/.test(cue.text.trim()) && Number(cue.text) === Number(w))
		return true
	return textMatches(cue.text, w, mode || 'exact')
}

module.exports = { getFeedbackDefinitions, sectionMatches, cueMatches }
