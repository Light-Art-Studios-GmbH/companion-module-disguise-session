/**
 * @file Action definitions.
 *
 * Every transport action has a "Transport" option: the active transport, all transports, one transport or a
 * multitransport (commands are sent to its members), or a typed name. Options with `useVariables` arrive
 * already parsed (module API 2.x).
 */
const { PLAY_MODES } = require('./api.js')
const { propertyChoices, propertyOf } = require('./layer-properties.js')

const PLAYMODE_CHOICES = [
	{ id: 'NotSet', label: 'Keep current play mode' },
	{ id: 'Play', label: 'Play' },
	{ id: 'PlaySection', label: 'Play to end of section' },
	{ id: 'Loop', label: 'Loop section' },
	{ id: 'Stop', label: 'Stop' },
]

const MATCH_CHOICES = [
	{ id: 'exact', label: 'Equals (case-insensitive)' },
	{ id: 'starts', label: 'Starts with' },
	{ id: 'contains', label: 'Contains' },
]

const KIND_CHOICES = [
	{ id: 'tag:CUE', label: 'Cue tags (CUE)' },
	{ id: 'tag:MIDI', label: 'MIDI tags' },
	{ id: 'tag:TC', label: 'Timecode tags (TC)' },
	{ id: 'note', label: 'Notes' },
	{ id: 'section', label: 'Section name or index' },
	{ id: 'tag', label: 'Any tag type' },
]

/**
 * @param {import('./instance.js').DisguiseInstance} instance
 */
function transportOption(instance) {
	return {
		id: 'transport',
		type: 'dropdown',
		label: 'Transport',
		default: 'active',
		choices: instance.transportChoices(),
		allowCustom: true,
		minChoicesForSearch: 0,
		tooltip: 'Pick a transport or type its name. Multitransports address all their members.',
	}
}

/** @param {string} [def] */
function playmodeOption(def = 'NotSet') {
	return {
		id: 'playmode',
		type: 'dropdown',
		label: 'Play mode after the jump',
		default: PLAY_MODES.includes(def) ? def : 'NotSet',
		choices: PLAYMODE_CHOICES,
	}
}

/**
 * @param {import('./instance.js').DisguiseInstance} instance
 * @returns {import('@companion-module/base').CompanionActionDefinitions}
 */
function getActionDefinitions(instance) {
	const T = () => transportOption(instance)
	/** Layer commands always address the active transport (the one visible in Designer). */
	const onActive = (what, _action, fn) => {
		const targets = instance.resolveTargets('active')
		if (targets.length === 0) {
			instance.log('warn', `${what}: no active transport`)
			return
		}
		return instance.run(`${what} (${targets.map((t) => t.name).join(', ')})`, () => fn(targets))
	}
	/** Resolves the transport option and runs `fn(targets)` with error logging. */
	const withTargets = (what, action, fn) => {
		const targets = instance.resolveTargets(action.options.transport)
		if (targets.length === 0) {
			instance.log('warn', `${what}: no transport matches "${action.options.transport}"`)
			return
		}
		return instance.run(`${what} (${targets.map((t) => t.name).join(', ')})`, () => fn(targets))
	}

	return {
		// ───────────────────────────────────────────── transport
		play: {
			name: 'Play',
			options: [T()],
			callback: (a) => withTargets('Play', a, (t) => instance.api.play(t)),
		},
		stop: {
			name: 'Stop',
			options: [T()],
			callback: (a) => withTargets('Stop', a, (t) => instance.api.stop(t)),
		},
		play_section: {
			name: 'Play to end of section',
			options: [T()],
			callback: (a) => withTargets('Play section', a, (t) => instance.api.playSection(t)),
		},
		loop_section: {
			name: 'Loop section',
			options: [T()],
			callback: (a) => withTargets('Loop section', a, (t) => instance.api.playLoopSection(t)),
		},
		return_to_start: {
			name: 'Return to start',
			options: [T()],
			callback: (a) => withTargets('Return to start', a, (t) => instance.api.returnToStart(t)),
		},
		toggle_play: {
			name: 'Play / stop (toggle)',
			description: 'Stops when the transport is playing, otherwise plays',
			options: [T()],
			callback: (a) =>
				withTargets('Toggle play', a, (t) => {
					const playing = t.filter((x) => x.playing)
					const stopped = t.filter((x) => !x.playing)
					return Promise.all([
						playing.length ? instance.api.stop(playing) : null,
						stopped.length ? instance.api.play(stopped) : null,
					])
				}),
		},

		// ───────────────────────────────────────────── sections
		next_section: {
			name: 'Next section (Designer native)',
			description: "Designer's own next section behaviour",
			options: [T(), playmodeOption()],
			callback: (a) => withTargets('Next section', a, (t) => instance.api.gotoNextSection(t, a.options.playmode)),
		},
		prev_section: {
			name: 'Previous section (Designer native)',
			description: "Designer's own previous section behaviour",
			options: [T(), playmodeOption()],
			callback: (a) => withTargets('Previous section', a, (t) => instance.api.gotoPrevSection(t, a.options.playmode)),
		},
		section_relative: {
			name: 'Jump sections (relative to the current one)',
			description:
				'Jumps to the START of the section that is <delta> sections away: −1 = start of the previous section (a real "back" key), 0 = restart the current section, +1 = next section, −10 = ten sections back. Clamped to the first/last section.',
			options: [
				T(),
				{
					id: 'delta',
					type: 'textinput',
					label: 'Delta (sections, negative = back)',
					default: '-1',
					useVariables: true,
				},
				playmodeOption(),
			],
			callback: (a) => {
				const delta = Math.trunc(Number(a.options.delta))
				if (!Number.isFinite(delta)) {
					instance.log('warn', `Jump sections: delta "${a.options.delta}" is not a number`)
					return
				}
				return withTargets(`Jump ${delta} section(s)`, a, (t) => instance.jumpSections(t, delta, a.options.playmode))
			},
		},
		goto_section: {
			name: 'Go to section (index or name)',
			options: [
				T(),
				{
					id: 'section',
					type: 'textinput',
					label: 'Section index (0, 1, 2 …) or section name',
					default: '1',
					useVariables: true,
				},
				playmodeOption(),
			],
			callback: (a) =>
				withTargets('Go to section', a, (t) => instance.gotoSectionText(t, a.options.section, a.options.playmode)),
		},

		// ───────────────────────────────────────────── cues / time / track
		goto_cue: {
			name: 'Go to cue / note / tag / section by text',
			description:
				'Searches one kind of annotation (cue tags, MIDI tags, timecode tags, notes or section names) of the current track and jumps there. Optionally also searches the other tracks of the setlist.',
			options: [
				T(),
				{
					id: 'text',
					type: 'textinput',
					label: 'Cue number, note text or section name',
					default: '',
					useVariables: true,
				},
				{ id: 'kind', type: 'dropdown', label: 'Search in', default: 'tag:CUE', choices: KIND_CHOICES },
				{ id: 'match', type: 'dropdown', label: 'Match', default: 'exact', choices: MATCH_CHOICES },
				{
					id: 'otherTracks',
					type: 'checkbox',
					label: 'Also search the other tracks (switches track)',
					default: true,
				},
				playmodeOption(),
			],
			callback: (a) =>
				withTargets(`Go to cue "${a.options.text}"`, a, (t) =>
					instance.gotoCue(
						t,
						a.options.text,
						{ kind: a.options.kind, match: a.options.match, otherTracks: !!a.options.otherTracks },
						a.options.playmode,
					),
				),
		},
		goto_time: {
			name: 'Go to time',
			options: [
				T(),
				{
					id: 'time',
					type: 'textinput',
					label: 'Time: seconds (12.5), MM:SS, HH:MM:SS or HH:MM:SS:FF',
					default: '00:00:00:00',
					useVariables: true,
				},
				playmodeOption(),
			],
			callback: (a) =>
				withTargets('Go to time', a, (t) => instance.gotoTimeText(t, a.options.time, a.options.playmode)),
		},
		goto_track: {
			name: 'Go to track',
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
				playmodeOption(),
			],
			callback: (a) =>
				withTargets('Go to track', a, (t) => instance.gotoTrackOption(t, a.options.track, a.options.playmode)),
		},
		next_track: {
			name: 'Next track',
			options: [T(), playmodeOption()],
			callback: (a) => withTargets('Next track', a, (t) => instance.api.gotoNextTrack(t, a.options.playmode)),
		},
		prev_track: {
			name: 'Previous track',
			options: [T(), playmodeOption()],
			callback: (a) => withTargets('Previous track', a, (t) => instance.api.gotoPrevTrack(t, a.options.playmode)),
		},

		// ───────────────────────────────────────────── engage, levels
		engage: {
			name: 'Engage / disengage',
			options: [
				T(),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'Engage' },
						{ id: 'off', label: 'Disengage' },
					],
				},
			],
			callback: (a) => withTargets(`Engage ${a.options.mode}`, a, (t) => instance.setEngaged(t, a.options.mode)),
		},
		set_volume: {
			name: 'Volume: set',
			options: [T(), { id: 'value', type: 'textinput', label: 'Volume (0–100 %)', default: '100', useVariables: true }],
			callback: (a) => withTargets('Set volume', a, (t) => instance.setLevel(t, 'volume', a.options.value, false)),
		},
		adjust_volume: {
			name: 'Volume: adjust',
			options: [
				T(),
				{ id: 'value', type: 'textinput', label: 'Step (%, negative = down)', default: '5', useVariables: true },
			],
			callback: (a) => withTargets('Adjust volume', a, (t) => instance.setLevel(t, 'volume', a.options.value, true)),
		},
		set_brightness: {
			name: 'Brightness: set',
			options: [
				T(),
				{ id: 'value', type: 'textinput', label: 'Brightness (0–100 %)', default: '100', useVariables: true },
			],
			callback: (a) =>
				withTargets('Set brightness', a, (t) => instance.setLevel(t, 'brightness', a.options.value, false)),
		},
		adjust_brightness: {
			name: 'Brightness: adjust',
			options: [
				T(),
				{ id: 'value', type: 'textinput', label: 'Step (%, negative = down)', default: '5', useVariables: true },
			],
			callback: (a) =>
				withTargets('Adjust brightness', a, (t) => instance.setLevel(t, 'brightness', a.options.value, true)),
		},

		goto_timecode: {
			name: 'Go to timecode (Designer native)',
			description:
				"Jumps to a timecode with Designer's gototimecode. Seconds or partial times are converted with the transport's frame rate.",
			options: [
				T(),
				{
					id: 'timecode',
					type: 'textinput',
					label: 'Timecode HH:MM:SS:FF',
					default: '00:00:00:00',
					useVariables: true,
				},
				{ id: 'ignoreTags', type: 'checkbox', label: 'Ignore timecode tags (absolute track time)', default: false },
				playmodeOption(),
			],
			callback: (a) =>
				withTargets('Go to timecode', a, (t) =>
					instance.gotoTimecodeText(t, a.options.timecode, !!a.options.ignoreTags, a.options.playmode),
				),
		},

		// ───────────────────────────────────────────── master output (Director)
		master_fade: {
			name: 'Master: fade down / fade up / hold',
			description: "Designer's master output (fade down = black, fade up, hold). Uses the project's fade duration.",
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'fadedown',
					choices: [
						{ id: 'fadedown', label: 'Fade down (to black)' },
						{ id: 'fadeup', label: 'Fade up' },
						{ id: 'hold', label: 'Hold' },
						{ id: 'toggle', label: 'Toggle fade down / fade up' },
					],
				},
			],
			callback: (a) => instance.run(`Master ${a.options.mode}`, () => instance.masterFade(a.options.mode)),
		},
		save_project: {
			name: 'Project: save and backup',
			description: "Designer's save and backup of the project file (the same as Alt+W).",
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Save mode',
					default: 'interactive',
					choices: [
						{ id: 'interactive', label: 'Interactive (like Alt+W, shows the confirmation in Designer)' },
						{ id: 'silent', label: 'Silent (like autosave, no confirmation)' },
					],
				},
			],
			callback: (a) => instance.run(`Save project (${a.options.mode})`, () => instance.saveProject(a.options.mode)),
		},
		set_fade_duration: {
			name: 'Master: set fade duration',
			options: [{ id: 'seconds', type: 'textinput', label: 'Seconds', default: '0.75', useVariables: true }],
			callback: (a) => instance.run('Set fade duration', () => instance.setFadeDuration(a.options.seconds)),
		},

		// ───────────────────────────────────────────── layers (current track of the transport)
		layer_add: {
			name: 'Layer: add new layer at the playhead',
			description:
				'Creates a new layer of the given type on the current track, starting at the playhead (or a given time).',
			options: [
				{
					id: 'type',
					type: 'dropdown',
					label: 'Layer type',
					default: 'VariableVideo',
					choices: instance.layerTypeChoices(),
					allowCustom: true,
					minChoicesForSearch: 0,
					tooltip: 'The list comes from the Director (Designer module classes). Type a name if it is missing.',
				},
				{ id: 'name', type: 'textinput', label: 'Layer name (empty = type name)', default: '', useVariables: true },
				{ id: 'length', type: 'textinput', label: 'Length (seconds)', default: '10', useVariables: true },
				{ id: 'toSectionEnd', type: 'checkbox', label: 'Length = until the next section', default: false },
				{
					id: 'start',
					type: 'textinput',
					label: 'Start (empty = playhead; seconds or HH:MM:SS:FF)',
					default: '',
					useVariables: true,
				},
			],
			callback: (a) =>
				onActive(`Add layer ${a.options.type}`, a, (t) =>
					instance.layerAdd(t, {
						type: a.options.type,
						name: a.options.name,
						length: a.options.length,
						start: a.options.start,
						toSectionEnd: !!a.options.toSectionEnd,
					}),
				),
		},
		layer_duplicate: {
			name: 'Layer: duplicate by name',
			description:
				'Duplicates a layer of the current track (a way to "load" a prepared layer: keep templates on the track and copy them).',
			options: [
				{ id: 'name', type: 'textinput', label: 'Layer name', default: '', useVariables: true },
				{
					id: 'newName',
					type: 'textinput',
					label: 'Name of the copy (empty = "<name> copy")',
					default: '',
					useVariables: true,
				},
			],
			callback: (a) =>
				onActive(`Duplicate layer ${a.options.name}`, a, (t) =>
					instance.layerDuplicate(t, a.options.name, a.options.newName),
				),
		},
		layer_enable: {
			name: 'Layer: enable / disable by name',
			options: [
				{ id: 'name', type: 'textinput', label: 'Layer name', default: '', useVariables: true },
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'Enable' },
						{ id: 'off', label: 'Disable' },
					],
				},
			],
			callback: (a) =>
				onActive(`Layer ${a.options.name} ${a.options.mode}`, a, (t) =>
					instance.layerEnable(t, a.options.name, a.options.mode),
				),
		},
		layer_extents: {
			name: 'Layer: move / resize by name',
			options: [
				{ id: 'name', type: 'textinput', label: 'Layer name', default: '', useVariables: true },
				{
					id: 'start',
					type: 'textinput',
					label: 'Start (empty = keep; seconds or HH:MM:SS:FF)',
					default: '',
					useVariables: true,
				},
				{ id: 'length', type: 'textinput', label: 'Length in seconds (empty = keep)', default: '', useVariables: true },
			],
			callback: (a) =>
				onActive(`Layer ${a.options.name} extents`, a, (t) =>
					instance.layerExtents(t, a.options.name, a.options.start, a.options.length),
				),
		},
		layer_remove: {
			name: 'Layer: remove by name',
			description: 'Removes the layer from the current track (no undo!)',
			options: [{ id: 'name', type: 'textinput', label: 'Layer name', default: '', useVariables: true }],
			callback: (a) => onActive(`Remove layer ${a.options.name}`, a, (t) => instance.layerRemove(t, a.options.name)),
		},

		layer_selected: {
			name: 'Layer: duplicate / copy / cut / paste the selection (active transport)',
			description:
				'Works on the layers selected in the Designer GUI of the machine the commands go to: duplicate copies them in place, copy remembers them and paste duplicates them at the playhead, cut remembers them and paste moves them to the playhead.',
			options: [
				{
					id: 'op',
					type: 'dropdown',
					label: 'Operation',
					default: 'duplicate',
					choices: [
						{ id: 'duplicate', label: 'Duplicate the selected layers' },
						{ id: 'copy', label: 'Copy the selected layers' },
						{ id: 'cut', label: 'Cut the selected layers' },
						{ id: 'paste', label: 'Paste at the playhead' },
					],
				},
			],
			callback: (a) => onActive(`Layer ${a.options.op}`, a, (t) => instance.layerSelection(t, a.options.op)),
		},
		layer_fit: {
			name: 'Layer: fit the selected layers to their content length',
			options: [],
			callback: (a) => onActive('Layer fit to content', a, (t) => instance.layerFit(t)),
		},
		layer_fade: {
			name: 'Layer: keyframe fade on the selected layers',
			description:
				'Writes two keyframes: from → to over the duration, anchored at the layer start, the layer end or the playhead.',
			options: [
				{ id: 'property', type: 'dropdown', label: 'Property', default: 'opacity', choices: propertyChoices() },
				{
					id: 'anchor',
					type: 'dropdown',
					label: 'Position',
					default: 'start',
					choices: [
						{ id: 'start', label: 'Start of the layer' },
						{ id: 'end', label: 'End of the layer' },
						{ id: 'playhead', label: 'Current position (playhead)' },
					],
				},
				{ id: 'from', type: 'textinput', label: 'From value', default: '0', useVariables: true },
				{ id: 'to', type: 'textinput', label: 'To value', default: '1', useVariables: true },
				{ id: 'seconds', type: 'textinput', label: 'Duration (seconds)', default: '1', useVariables: true },
			],
			callback: (a) =>
				onActive(`Keyframe fade ${propertyOf(a.options.property).label}`, a, (t) => instance.layerFade(t, a.options)),
		},
		layer_keys_clear: {
			name: 'Layer: clear keyframes of a property on the selected layers',
			description: 'Removes all keyframes of the property and leaves a static value.',
			options: [
				{ id: 'property', type: 'dropdown', label: 'Property', default: 'opacity', choices: propertyChoices() },
				{ id: 'value', type: 'textinput', label: 'Static value', default: '1', useVariables: true },
			],
			callback: (a) =>
				onActive(`Clear keyframes ${propertyOf(a.options.property).label}`, a, (t) =>
					instance.layerKeysClear(t, a.options),
				),
		},
		layer_blendmode: {
			name: 'Layer: assign blend mode (mix mode) to the selected layers',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Blend mode',
					default: 'Over',
					choices: (instance.blendModes.length
						? instance.blendModes
						: ['Over', 'Alpha', 'Add', 'Multiply', 'Mask', 'Screen']
					).map((m) => ({ id: m, label: m })),
					allowCustom: true,
					minChoicesForSearch: 0,
				},
			],
			callback: (a) => onActive(`Blend mode ${a.options.mode}`, a, (t) => instance.layerBlendMode(t, a.options.mode)),
		},
		layer_mapping: {
			name: 'Layer: assign mapping to the selected layers',
			options: [
				{
					id: 'mapping',
					type: 'dropdown',
					label: 'Mapping',
					default: instance.mappings[0] || '',
					choices: instance.mappings.map((m) => ({ id: m, label: m })),
					allowCustom: true,
					minChoicesForSearch: 0,
					tooltip: 'Mappings of the project (Designer names); the list comes from the Director',
				},
			],
			callback: (a) => onActive(`Mapping ${a.options.mapping}`, a, (t) => instance.layerMapping(t, a.options.mapping)),
		},
		layer_playmode: {
			name: 'Layer: assign play mode (Normal / Locked) to the selected layers',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Play mode',
					default: 'Normal',
					choices: [
						{ id: 'Normal', label: 'Normal' },
						{ id: 'Locked', label: 'Locked' },
					],
					allowCustom: true,
				},
			],
			callback: (a) =>
				onActive(`Play mode ${a.options.mode}`, a, (t) => instance.layerAssign(t, 'mode', a.options.mode)),
		},
		layer_endpoint: {
			name: 'Layer: assign "at end point" (Loop / Ping-pong / Pause) to the selected layers',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'At end point',
					default: 'Loop',
					choices: [
						{ id: 'Loop', label: 'Loop' },
						{ id: 'Ping-pong', label: 'Ping-pong' },
						{ id: 'Pause', label: 'Pause' },
					],
					allowCustom: true,
				},
			],
			callback: (a) =>
				onActive(`At end point ${a.options.mode}`, a, (t) => instance.layerAssign(t, 'at end point', a.options.mode)),
		},
		layer_set_field: {
			name: 'Layer: assign any field of the selected layers (static)',
			description:
				'Designer field name as shown in the layer editor (e.g. speed, volume, brightness, mode) and a number or option name.',
			options: [
				{ id: 'field', type: 'textinput', label: 'Field name', default: 'speed', useVariables: true },
				{ id: 'value', type: 'textinput', label: 'Value (number or option name)', default: '1', useVariables: true },
			],
			callback: (a) =>
				onActive(`Assign ${a.options.field}`, a, (t) => instance.layerAssign(t, a.options.field, a.options.value)),
		},
		note_append: {
			name: 'Notes: add a line to a note list or the track note',
			description:
				'Appends a paragraph to a Designer note: a global note list (Notes widget) or the note of the track shown in the GUI. The prefix parts are written in front of the text, separated by " | ".',
			options: [
				{
					id: 'target',
					type: 'dropdown',
					label: 'Note',
					default: 'track',
					choices: [
						{ id: 'track', label: 'Note of the current track' },
						...instance.trackChoices().map((t) => ({ id: `track:${t.id}`, label: `Note of track "${t.label}"` })),
						...instance.noteLists.map((n) => ({ id: n, label: `Note list "${n}"` })),
					],
					allowCustom: true,
					minChoicesForSearch: 0,
					tooltip: 'Tracks and note lists come from the project; typed: a note list name or track:<track name>',
				},
				{ id: 'text', type: 'textinput', label: 'Text', default: 'Check this', useVariables: true },
				{
					id: 'parts',
					type: 'multidropdown',
					label: 'Prefix',
					default: ['timecode'],
					choices: [
						{ id: 'datetime', label: 'Date and time' },
						{ id: 'time', label: 'Time of day' },
						{ id: 'timecode', label: 'Transport time (HH:MM:SS:FF)' },
						{ id: 'transport', label: 'Transport name' },
						{ id: 'track', label: 'Track name' },
						{ id: 'section', label: 'Section name' },
					],
					minSelection: 0,
					sortSelection: true,
				},
			],
			callback: (a) => instance.run(`Note "${a.options.text}"`, () => instance.noteAppend(a.options)),
		},
		add_annotation: {
			name: 'Track: add tag / note at the playhead (active transport)',
			options: [
				{
					id: 'kind',
					type: 'dropdown',
					label: 'Kind',
					default: 'cue',
					choices: [
						{ id: 'cue', label: 'Cue tag (CUE)' },
						{ id: 'midi', label: 'MIDI tag' },
						{ id: 'tc', label: 'Timecode tag (TC)' },
						{ id: 'note', label: 'Note' },
					],
				},
				{ id: 'text', type: 'textinput', label: 'Value / text', default: '1', useVariables: true },
			],
			callback: (a) =>
				onActive(`Add ${a.options.kind} ${a.options.text}`, a, (t) => instance.addAnnotation(t, a.options)),
		},
		section_crossfade: {
			name: 'Section: crossfade of the current section (active transport)',
			description:
				'Sets the crossfade of the section the playhead is in: undefined, or fade with a duration and the loop crossfade flag.',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Crossfade',
					default: 'fade',
					choices: [
						{ id: 'undefined', label: 'Undefined' },
						{ id: 'fade', label: 'Fade' },
					],
				},
				{
					id: 'seconds',
					type: 'textinput',
					label: 'Fade duration (seconds)',
					default: '1',
					useVariables: true,
					isVisibleExpression: '$(options:mode) == "fade"',
				},
				{
					id: 'loop',
					type: 'checkbox',
					label: 'Loop crossfade',
					default: false,
					isVisibleExpression: '$(options:mode) == "fade"',
				},
			],
			callback: (a) =>
				onActive(`Section crossfade ${a.options.mode}`, a, (t) => instance.sectionCrossfade(t, a.options)),
		},
		insert_time: {
			name: 'Track: insert / remove time at the playhead (active transport)',
			options: [
				{ id: 'seconds', type: 'textinput', label: 'Seconds', default: '5', useVariables: true },
				{
					id: 'layers',
					type: 'dropdown',
					label: 'Layers',
					default: 'move',
					choices: [
						{ id: 'move', label: 'Move layers' },
						{ id: 'stretch', label: 'Stretch layers' },
						{ id: 'none', label: "Don't touch layers" },
					],
				},
				{ id: 'remove', type: 'checkbox', label: 'Remove instead of insert', default: false },
			],
			callback: (a) =>
				onActive(`${a.options.remove ? 'Remove' : 'Insert'} ${a.options.seconds} s`, a, (t) =>
					instance.insertTime(t, a.options),
				),
		},
		section_split: {
			name: 'Section: split / merge at the playhead (active transport)',
			description:
				'Split creates a section boundary at the playhead; merge removes the boundary at the start of the current section (like Designer).',
			options: [
				{
					id: 'op',
					type: 'dropdown',
					label: 'Operation',
					default: 'split',
					choices: [
						{ id: 'split', label: 'Split: new section boundary at the playhead' },
						{ id: 'merge', label: 'Merge: remove the boundary of the current section' },
					],
				},
			],
			callback: (a) => onActive(`Section ${a.options.op}`, a, (t) => instance.sectionSplit(t, a.options.op)),
		},

		// ───────────────────────────────────────────── editor, machines
		editor_mode: {
			name: 'Editor: lock to Director / independent playback',
			description:
				'Switches the machine the commands go to (meant for an editor) between following the Director and independent playback.',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'lock', label: 'Lock to Director' },
						{ id: 'independent', label: 'Independent playback' },
					],
				},
			],
			callback: (a) => instance.run(`Editor mode ${a.options.mode}`, () => instance.editorMode(a.options.mode)),
		},
		machine_ack: {
			name: 'Machine: acknowledge alerts (dropped frames, states, notifications)',
			description: 'Clears the alert indication of the machine until something new happens.',
			options: [
				{
					id: 'machine',
					type: 'dropdown',
					label: 'Machine',
					default: 'all',
					choices: [{ id: 'all', label: 'All machines' }, ...instance.machineChoices()],
					allowCustom: true,
					minChoicesForSearch: 0,
				},
			],
			callback: (a) => instance.acknowledgeMachine(a.options.machine),
		},

		// ───────────────────────────────────────────── failover (session)
		failover_machine: {
			name: 'Failover replace: replace a machine by its understudy',
			description:
				"Designer's /failover/failovermachine – the machine to replace (an understudy target), not the understudy itself. Sent to every configured host (Director, backup, editor) so it also lands when the Director is gone.",
			options: [failoverTargetOption(instance)],
			callback: (a) =>
				instance.run(`Failover replace ${a.options.target}`, () =>
					instance.failoverMachine(a.options.target, 'failover'),
				),
		},
		restore_machine: {
			name: 'Failover restore: give a replaced machine its role back',
			description: "Designer's /failover/restoremachine – sent to every configured host (Director, backup, editor).",
			options: [failoverTargetOption(instance)],
			callback: (a) =>
				instance.run(`Failover restore ${a.options.target}`, () =>
					instance.failoverMachine(a.options.target, 'restore'),
				),
		},
		apply_default_routing: {
			name: 'Failover: apply default matrix routing',
			options: [],
			callback: () => instance.run('Apply default routing', () => instance.api.applyDefaultRouting()),
		},
		use_host: {
			name: 'Connection: use Director / backup / editor host',
			description:
				'Switches which configured machine receives the commands. Director/backup keep following the Director; while the editor is selected, following is paused.',
			options: [
				{
					id: 'which',
					type: 'dropdown',
					label: 'Host',
					default: 'director',
					choices: [
						{ id: 'director', label: 'The Director (whichever machine is Director now)' },
						{ id: 'editor', label: 'Editor' },
						{ id: 'primary', label: 'Director host (as configured)' },
						{ id: 'backup', label: 'Backup host' },
						{ id: 'toggle', label: 'Toggle Director host / backup host' },
					],
				},
			],
			callback: (a) => instance.run(`Use host ${a.options.which}`, () => instance.useHostOption(a.options.which)),
		},

		// ───────────────────────────────────────────── session
		refresh: {
			name: 'Refresh session (transports, tracks, cues, health)',
			options: [],
			callback: () => instance.refreshSession(true, true),
		},
	}
}

/** @param {import('./instance.js').DisguiseInstance} instance */
function failoverTargetOption(instance) {
	return {
		id: 'target',
		type: 'dropdown',
		label: 'Machine to replace / restore',
		default: instance.failoverTargetChoices()[0]?.id || '',
		choices: instance.failoverTargetChoices(),
		allowCustom: true,
		minChoicesForSearch: 0,
		tooltip: 'Understudy targets from /failover/understudytargets',
	}
}

/** @param {import('./instance.js').DisguiseInstance} instance */
function machineOption(instance) {
	return {
		id: 'machine',
		type: 'dropdown',
		label: 'Machine',
		default: '',
		choices: instance.machineChoices(),
		allowCustom: true,
		minChoicesForSearch: 0,
		tooltip: 'Machine name or hostname as shown in the session',
	}
}

module.exports = {
	getActionDefinitions,
	transportOption,
	playmodeOption,
	machineOption,
	PLAYMODE_CHOICES,
	MATCH_CHOICES,
	KIND_CHOICES,
}
