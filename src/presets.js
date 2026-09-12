/**
 * @file Preset buttons (Companion 5 "layered" buttons).
 *
 * Every preset is a tile with the same layout so a button can be read at a glance:
 *   header  – small, muted: what/whom the button belongs to ("fg · section", "director-1 · director")
 *   main    – large: the value or the icon
 *   footer  – small: unit, next step or the action name
 * Feedbacks recolour the background (element "bg") or change the main text.
 *
 * Colours are deliberately darker than pure RGB so text stays readable on a Stream Deck.
 * Variables are referenced through the connection label, so presets are rebuilt when the label or the
 * session (transports, machines, layer types) changes – see DisguiseInstance.publishPresets().
 */
const { combineRgb } = require('@companion-module/base')
const { icons } = require('./icons.js')
const { LAYER_PROPERTIES } = require('./layer-properties.js')

const WHITE = combineRgb(245, 245, 245)
const DARK = combineRgb(18, 18, 20)
const PANEL = combineRgb(40, 40, 44)
const MUTED = combineRgb(150, 150, 156)
const GREEN = combineRgb(22, 105, 48)
const GREEN_TXT = combineRgb(110, 210, 125)
const RED = combineRgb(140, 26, 26)
const BLUE = combineRgb(28, 66, 140)
const AMBER = combineRgb(160, 112, 18)
const ORANGE = combineRgb(165, 82, 26)
const TEAL = combineRgb(18, 100, 100)
const PURPLE = combineRgb(84, 44, 130)

/**
 * A layered tile. `feedbacks` entries are {feedbackId, options, isInverted?, bg?, mainColor?, text?, footer?, footerColor?, headerColor?}.
 * @param {object} o
 */
function tile(o) {
	const elements = [
		{
			id: 'bg',
			type: 'box',
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			color: o.bg || DARK,
			cornerRadius: 0,
		},
	]
	const hasHeader = o.header !== undefined
	const hasFooter = o.footer !== undefined
	if (hasHeader) {
		elements.push({
			id: 'header',
			type: 'text',
			x: 3,
			y: 2,
			width: 94,
			height: 16,
			text: o.header,
			fontsize: 92,
			fontsizeAllowShrink: true,
			color: o.headerColor || MUTED,
			halign: 'left',
			valign: 'center',
		})
	}
	const mainY = hasHeader ? 19 : 4
	const mainH = 100 - mainY - (hasFooter ? 21 : 4)
	if (o.icon) {
		elements.push({
			id: 'icon',
			type: 'image',
			x: 20,
			y: mainY + 2,
			width: 60,
			height: mainH - 4,
			base64Image: o.icon,
			fillMode: 'fit',
		})
	} else {
		elements.push({
			id: 'main',
			type: 'text',
			x: 2,
			y: mainY,
			width: 96,
			height: mainH,
			text: o.main ?? '',
			fontsize: o.mainSize || 62,
			fontsizeAllowShrink: true,
			weight: o.mainWeight || 'bold',
			font: o.mono ? 'companion-mono' : 'companion-sans',
			color: o.mainColor || WHITE,
			halign: 'center',
			valign: 'center',
		})
	}
	if (hasFooter) {
		elements.push({
			id: 'footer',
			type: 'text',
			x: 3,
			y: 80,
			width: 94,
			height: 17,
			text: o.footer,
			fontsize: 92,
			fontsizeAllowShrink: true,
			color: o.footerColor || MUTED,
			halign: 'center',
			valign: 'center',
		})
	}
	if (o.gauge) {
		elements.push({
			id: 'gauge',
			type: 'gauge',
			x: 6,
			y: 72,
			width: 88,
			height: 7,
			value: { isExpression: true, value: o.gauge.expr },
			min: 0,
			max: o.gauge.max ?? 100,
			orientation: 'horizontal',
			fillEnabled: true,
			stops: [
				{
					value: o.gauge.max ?? 100,
					color: o.gauge.color || AMBER,
					gradient: false,
				},
			],
			trackStyle: 'dimmed',
			trackAmount: 30,
		})
	}
	// Companion expects overrides as {isExpression, value}; plain values are silently dropped together with the feedback.
	const ov = (value) => ({ isExpression: false, value })
	const feedbacks = (o.feedbacks || []).map((f) => {
		const styleOverrides = []
		if (f.bg !== undefined)
			styleOverrides.push({
				elementId: 'bg',
				elementProperty: 'color',
				override: ov(f.bg),
			})
		if (f.mainColor !== undefined && !o.icon)
			styleOverrides.push({
				elementId: 'main',
				elementProperty: 'color',
				override: ov(f.mainColor),
			})
		if (f.text !== undefined && !o.icon)
			styleOverrides.push({
				elementId: 'main',
				elementProperty: 'text',
				override: ov(f.text),
			})
		if (f.footer !== undefined && hasFooter)
			styleOverrides.push({
				elementId: 'footer',
				elementProperty: 'text',
				override: ov(f.footer),
			})
		if (f.footerColor !== undefined && hasFooter)
			styleOverrides.push({
				elementId: 'footer',
				elementProperty: 'color',
				override: ov(f.footerColor),
			})
		if (f.headerColor !== undefined && hasHeader)
			styleOverrides.push({
				elementId: 'header',
				elementProperty: 'color',
				override: ov(f.headerColor),
			})
		return {
			feedbackId: f.feedbackId,
			options: f.options || {},
			styleOverrides,
			...(f.isInverted ? { isInverted: true } : {}),
		}
	})
	const step = { down: o.actions || [], up: [] }
	if (o.rotate) {
		step.rotate_left = o.rotate.left
		step.rotate_right = o.rotate.right
	}
	return {
		type: 'layered',
		name: o.name,
		elements,
		steps: [step],
		feedbacks,
		...(o.rotate ? { options: { rotaryActions: true } } : {}),
	}
}

/**
 * @param {import('./instance.js').DisguiseInstance} instance
 * @returns {{structure: any[], presets: Record<string, any>}}
 */
function getPresetDefinitions(instance) {
	const label = instance.label || 'd3-session'
	const g = (name) => `$(${label}:${name})`
	const warn = Math.max(1, Number(instance.config?.warnSeconds) || 10)
	/** @type {Record<string, any>} */
	const presets = {}
	const structure = []
	const add = (id, def) => {
		presets[id] = def
		return id
	}
	/** Warning feedback (blinking) for "next section in" tiles. */
	const warnFb = (tr) => ({
		feedbackId: 'remaining_below',
		options: {
			...tr,
			seconds: warn,
			onlyPlaying: true,
			needNext: true,
			blink: true,
		},
		bg: ORANGE,
		mainColor: WHITE,
		footerColor: WHITE,
		headerColor: WHITE,
	})

	// ───────────────────────────────────────────── session / director / master
	const session = [
		add(
			'session_status',
			tile({
				name: 'Director status',
				header: 'Director',
				main: g('director'),
				mainSize: 48,
				footer: g('session_mode'),
				bg: RED,
				actions: [{ actionId: 'refresh', options: {} }],
				feedbacks: [{ feedbackId: 'connected', options: {}, bg: GREEN }],
			}),
		),
		add(
			'session_project',
			tile({
				name: 'Project and Designer version',
				header: 'Project',
				main: g('project'),
				mainSize: 44,
				footer: `Designer ${g('designer_version')}`,
				bg: PANEL,
				actions: [{ actionId: 'refresh', options: {} }],
				feedbacks: [{ feedbackId: 'connected', options: {}, isInverted: true, bg: RED }],
			}),
		),
		add(
			'session_active_host',
			tile({
				name: 'Commands go to (Director / backup / editor)',
				header: 'Commands go to',
				main: g('active_machine'),
				mainSize: 48,
				footer: g('active_host'),
				bg: PANEL,
				actions: [{ actionId: 'use_host', options: { which: 'toggle' } }],
				feedbacks: [
					{
						feedbackId: 'on_backup',
						options: {},
						bg: ORANGE,
						footerColor: WHITE,
						headerColor: WHITE,
					},
					{
						feedbackId: 'on_editor',
						options: {},
						bg: PURPLE,
						footerColor: WHITE,
						headerColor: WHITE,
					},
				],
			}),
		),
		add(
			'session_host_primary',
			tile({
				name: 'Director host',
				header: `Director host`,
				main: g('primary_state'),
				mainSize: 44,
				footer: g('primary_host'),
				bg: RED,
				actions: [{ actionId: 'use_host', options: { which: 'primary' } }],
				feedbacks: [
					{
						feedbackId: 'host_state',
						options: { which: 'primary', state: 'online' },
						bg: AMBER,
					},
					{
						feedbackId: 'host_state',
						options: { which: 'primary', state: 'director' },
						bg: GREEN,
					},
				],
			}),
		),
		add(
			'session_host_backup',
			tile({
				name: 'Backup host (understudy)',
				header: 'Backup host',
				main: g('backup_state'),
				mainSize: 44,
				footer: g('backup_host'),
				bg: PANEL,
				actions: [{ actionId: 'use_host', options: { which: 'backup' } }],
				feedbacks: [
					{
						feedbackId: 'host_state',
						options: { which: 'backup', state: 'offline' },
						bg: RED,
					},
					{
						feedbackId: 'host_state',
						options: { which: 'backup', state: 'online' },
						bg: AMBER,
					},
					{
						feedbackId: 'host_state',
						options: { which: 'backup', state: 'director' },
						bg: GREEN,
					},
				],
			}),
		),
		add(
			'master_toggle',
			tile({
				name: 'Master: fade up / fade down (toggle)',
				header: 'Master',
				main: g('master_output'),
				mainSize: 42,
				footer: `fade ${g('fade_duration')} s`,
				bg: GREEN,
				actions: [{ actionId: 'master_fade', options: { mode: 'toggle' } }],
				feedbacks: [
					{
						feedbackId: 'master_output',
						options: { mode: 'fadedown' },
						bg: RED,
					},
					{ feedbackId: 'master_output', options: { mode: 'hold' }, bg: AMBER },
				],
			}),
		),
		add(
			'master_hold',
			tile({
				name: 'Master: hold',
				header: 'Master',
				main: 'Hold',
				mainSize: 48,
				footer: g('master_output'),
				bg: PANEL,
				actions: [{ actionId: 'master_fade', options: { mode: 'hold' } }],
				feedbacks: [{ feedbackId: 'master_output', options: { mode: 'hold' }, bg: AMBER }],
			}),
		),
	]
	structure.push({
		id: 'session',
		name: 'Session, Director and master',
		definitions: session,
	})

	// ───────────────────────────────────────────── editor
	const editor = [
		add(
			'session_host_editor',
			tile({
				name: 'Send commands to Editor',
				header: `Editor ${g('editor_host')}`,
				main: 'Send commands to Editor',
				mainSize: 36,
				footer: g('editor_state'),
				bg: PANEL,
				actions: [{ actionId: 'use_host', options: { which: 'editor' } }],
				feedbacks: [
					{
						feedbackId: 'host_state',
						options: { which: 'editor', state: 'offline' },
						bg: RED,
					},
					{
						feedbackId: 'on_editor',
						options: {},
						bg: PURPLE,
						footerColor: WHITE,
						headerColor: WHITE,
					},
				],
			}),
		),
		add(
			'session_back_to_director',
			tile({
				name: 'Send commands to Director',
				header: `Director ${g('director')}`,
				main: 'Send commands to Director',
				mainSize: 36,
				footer: g('primary_state'),
				bg: PANEL,
				actions: [{ actionId: 'use_host', options: { which: 'director' } }],
				feedbacks: [
					{ feedbackId: 'on_backup', options: {}, isInverted: true, bg: GREEN },
					{ feedbackId: 'on_editor', options: {}, bg: PANEL },
				],
			}),
		),
		add(
			'editor_lock',
			tile({
				name: 'Editor: lock to Director / independent (toggle, shows the state)',
				header: `Editor ${g('editor_host')}`,
				main: g('editor_lock'),
				mainSize: 40,
				footer: 'press to toggle',
				bg: AMBER,
				actions: [{ actionId: 'editor_mode', options: { mode: 'toggle' } }],
				feedbacks: [
					{ feedbackId: 'editor_locked', options: {}, bg: GREEN },
					{
						feedbackId: 'host_state',
						options: { which: 'editor', state: 'offline' },
						bg: RED,
					},
				],
			}),
		),
	]
	structure.push({
		id: 'editor',
		name: 'Editor',
		description:
			'Control a Designer editor of the session with the same buttons: select it here, go back to the Director when done.',
		definitions: editor,
	})

	// ───────────────────────────────────────────── machines (health, failover)
	const machineTiles = []
	for (const m of instance.machineTargets()) {
		const v = (name) => g(`m_${m.key}_${name}`)
		const alertFb = {
			feedbackId: 'machine_health',
			options: {
				machine: m.name,
				dropped: true,
				states: true,
				notifications: true,
				minFps: 0,
				ignoreAck: false,
			},
			bg: RED,
		}
		for (const pair of instance.failover?.pairs || []) {
			const k = pair.target.toLowerCase().replace(/[^a-z0-9]+/g, '_')
			machineTiles.push(
				add(
					`failover_replace_${k}`,
					tile({
						name: `Failover replace ${pair.target} by ${pair.understudy}`,
						header: `Failover · ${pair.target}`,
						main: 'Replace',
						mainSize: 46,
						footer: `by ${pair.understudy}`,
						bg: PANEL,
						actions: [
							{
								actionId: 'failover_machine',
								options: { target: pair.target },
							},
						],
					}),
				),
				add(
					`failover_restore_${k}`,
					tile({
						name: `Failover restore ${pair.target}`,
						header: `Failover · ${pair.target}`,
						main: 'Restore',
						mainSize: 46,
						footer: `from ${pair.understudy}`,
						bg: PANEL,
						actions: [{ actionId: 'restore_machine', options: { target: pair.target } }],
					}),
				),
			)
		}
		machineTiles.push(
			add(
				`machine_${m.key}_health`,
				tile({
					name: `${m.name}: health (press = acknowledge)`,
					header: `${m.name} · ${v('role')}`,
					main: `${v('fps')} fps`,
					mainSize: 50,
					footer: `${v('alert_count')} alerts · drop ${v('dropped_frames')}`,
					bg: PANEL,
					actions: [{ actionId: 'machine_ack', options: { machine: m.name } }],
					feedbacks: [
						alertFb,
						{
							feedbackId: 'connected',
							options: {},
							isInverted: true,
							bg: DARK,
							mainColor: MUTED,
						},
					],
				}),
			),
			add(
				`machine_${m.key}_alerts`,
				tile({
					name: `${m.name}: alerts (press = acknowledge)`,
					header: `${m.name} · alerts`,
					main: v('alerts'),
					mainSize: 34,
					mainWeight: 'normal',
					footer: `${v('state')} · ${v('notifications')} notifications`,
					bg: PANEL,
					actions: [{ actionId: 'machine_ack', options: { machine: m.name } }],
					feedbacks: [
						alertFb,
						{
							feedbackId: 'machine_health',
							options: { ...alertFb.options },
							isInverted: true,
							text: 'OK',
							mainColor: GREEN_TXT,
						},
					],
				}),
			),
		)
	}
	machineTiles.push(
		add(
			'machines_ack_all',
			tile({
				name: 'Acknowledge all alerts',
				header: 'All machines',
				main: 'Ack',
				mainSize: 52,
				footer: `${g('dropped_frames')} dropped total`,
				bg: PANEL,
				actions: [{ actionId: 'machine_ack', options: { machine: 'all' } }],
				feedbacks: [{ feedbackId: 'dropped_frames', options: {}, bg: RED }],
			}),
		),
		add(
			'failover_default_routing',
			tile({
				name: 'Failover: apply default routing',
				header: 'Failover',
				main: 'Default routing',
				mainSize: 40,
				footer: g('failover_preset'),
				bg: PANEL,
				actions: [{ actionId: 'apply_default_routing', options: {} }],
			}),
		),
	)
	structure.push({
		id: 'machines',
		name: 'Machines (health, failover)',
		definitions: machineTiles,
	})

	// ───────────────────────────────────────────── per transport
	for (const target of instance.presetTargets()) {
		const { id, key, name, kind } = target
		const v = (n) => g(`${key}_${n}`)
		const tr = { transport: id }
		const hdr = kind === 'active' ? g('active_transport') : name
		const p = (suffix, def) => add(`${key}__${suffix}`, def)
		const modeFb = (mode, bg) => ({
			feedbackId: 'playmode',
			options: { ...tr, mode },
			bg,
		})
		const iconTile = (suffix, presetName, icon, footer, actionId, options, feedbacks = []) =>
			p(
				suffix,
				tile({
					name: `${name}: ${presetName}`,
					header: hdr,
					icon,
					footer,
					actions: [{ actionId, options: { ...tr, ...options } }],
					feedbacks,
				}),
			)
		const textTile = (suffix, presetName, o) =>
			p(
				suffix,
				tile({
					...o,
					name: `${name}: ${presetName}`,
					header: o.header === undefined ? hdr : o.header,
					actions:
						o.actions ||
						(o.actionId
							? [
									{
										actionId: o.actionId,
										options: { ...tr, ...(o.options || {}) },
									},
								]
							: undefined),
				}),
			)
		/** Big single value tile (hh / mm / ss / ff). */
		const digit = (suffix, presetName, headerText, varName, extra = {}) =>
			textTile(suffix, presetName, {
				header: headerText,
				main: v(varName),
				mono: true,
				mainSize: 90,
				...extra,
			})

		const control = [
			iconTile('play', 'Play', icons.play, 'Play', 'play', {}, [modeFb('Play', GREEN)]),
			iconTile('stop', 'Stop', icons.stop, 'Stop', 'stop', {}, [modeFb('Stop', RED)]),
			iconTile('play_section', 'Play to end of section', icons.play_section, 'Play section', 'play_section', {}, [
				modeFb('PlaySection', TEAL),
			]),
			iconTile('loop', 'Loop section', icons.loop, 'Loop', 'loop_section', {}, [modeFb('Loop', BLUE)]),
			iconTile('return', 'Return to start', icons.return_to_start, 'To start', 'return_to_start', {}),
			iconTile(
				'prev_section',
				'Previous section (start of previous)',
				icons.prev_section,
				'Prev section',
				'section_relative',
				{ delta: '-1', playmode: 'NotSet' },
			),
			iconTile('next_section', 'Next section', icons.next_section, 'Next section', 'section_relative', {
				delta: '1',
				playmode: 'NotSet',
			}),
			textTile('restart_section', 'Restart section', {
				main: '↺',
				mainSize: 80,
				footer: 'Restart section',
				actionId: 'section_relative',
				options: { delta: '0', playmode: 'NotSet' },
			}),
			iconTile('prev_track', 'Previous track', icons.prev_track, 'Prev track', 'prev_track', { playmode: 'NotSet' }),
			iconTile('next_track', 'Next track', icons.next_track, 'Next track', 'next_track', { playmode: 'NotSet' }),
			textTile('engage', 'Engage / disengage', {
				main: 'Disengaged',
				mainSize: 44,
				footer: 'press to engage',
				bg: PANEL,
				mainColor: MUTED,
				actionId: 'engage',
				options: { mode: 'toggle' },
				feedbacks: [
					{
						feedbackId: 'engaged',
						options: tr,
						bg: AMBER,
						text: 'Engaged',
						mainColor: WHITE,
						footer: 'press to disengage',
						footerColor: WHITE,
						headerColor: WHITE,
					},
				],
			}),
			textTile('toggle_play', 'Play / stop toggle', {
				main: 'Play',
				mainSize: 56,
				footer: v('playmode'),
				actionId: 'toggle_play',
				feedbacks: [{ feedbackId: 'playing', options: tr, bg: GREEN, text: 'Stop' }],
			}),
		]

		const displays = [
			textTile('time', 'Time (HH:MM:SS:FF)', {
				header: `${hdr} · time`,
				main: v('time_tc'),
				mono: true,
				mainSize: 44,
				footer: `${v('fps')} fps · ${v('playmode')}`,
				feedbacks: [{ feedbackId: 'playing', options: tr, mainColor: GREEN_TXT }],
			}),
			textTile('section', 'Current section', {
				header: `${hdr} · section ${v('section_index')}`,
				main: v('section_label'),
				mainSize: 46,
				footer: `next in -${v('section_remaining_tc')}`,
				feedbacks: [warnFb(tr)],
			}),
			textTile('cue', 'Current cue (tag)', {
				header: `${hdr} · cue`,
				main: v('tag_current'),
				mainSize: 52,
				footer: `next ${v('cue_next')}`,
			}),
			textTile('note', 'Current note', {
				header: `${hdr} · note`,
				main: v('note_current'),
				mainSize: 40,
				mainWeight: 'normal',
				footer: v('section_label'),
			}),
			textTile('next_section_info', 'Next section (press = jump)', {
				header: `${hdr} · next ${v('next_section_index')}`,
				main: v('next_section_label'),
				mainSize: 46,
				footer: `in -${v('section_remaining_mm')}:${v('section_remaining_ss')}`,
				actionId: 'section_relative',
				options: { delta: '1', playmode: 'NotSet' },
				feedbacks: [warnFb(tr)],
			}),
			textTile('section_elapsed', 'Elapsed in section', {
				header: `${hdr} · elapsed`,
				main: v('section_elapsed_tc'),
				mono: true,
				mainSize: 44,
				footer: `section ${v('section_index')} · ${v('section_label')}`,
			}),
			textTile('cue_next', 'Next cue in', {
				header: `${hdr} · next cue in`,
				main: `-${v('cue_next_remaining_tc')}`,
				mono: true,
				mainSize: 42,
				footer: v('cue_next'),
			}),
			textTile('section_remaining', `Next section in (warning at ${warn} s)`, {
				header: `${hdr} · next section in`,
				main: `-${v('section_remaining_tc')}`,
				mono: true,
				mainSize: 42,
				footer: v('next_section_label'),
				feedbacks: [warnFb(tr)],
			}),
			textTile('track_remaining', `End of track in (warning at ${warn} s)`, {
				header: `${hdr} · track ends in`,
				main: `-${v('track_remaining_tc')}`,
				mono: true,
				mainSize: 42,
				footer: v('track'),
				feedbacks: [
					{
						feedbackId: 'track_remaining_below',
						options: { ...tr, seconds: warn, onlyPlaying: true, blink: true },
						bg: RED,
					},
				],
			}),
		]

		const digits = [
			digit('time_hh', 'Time: hours', `${hdr} · time h`, 'time_hh'),
			digit('time_mm', 'Time: minutes', `${hdr} · time m`, 'time_mm'),
			digit('time_ss', 'Time: seconds', `${hdr} · time s`, 'time_ss'),
			digit('time_ff', 'Time: frames', `${hdr} · time f`, 'time_ff'),
			digit('remaining_hh', 'Next section in: hours', `${hdr} · next in h`, 'section_remaining_hh', {
				feedbacks: [warnFb(tr)],
			}),
			digit('remaining_mm', 'Next section in: minutes', `${hdr} · next in m`, 'section_remaining_mm', {
				feedbacks: [warnFb(tr)],
			}),
			digit('remaining_ss', 'Next section in: seconds', `${hdr} · next in s`, 'section_remaining_ss', {
				feedbacks: [warnFb(tr)],
			}),
			digit('remaining_ff', 'Next section in: frames', `${hdr} · next in f`, 'section_remaining_ff', {
				feedbacks: [warnFb(tr)],
			}),
		]

		const tcFb = [
			{
				feedbackId: 'receiving_timecode',
				options: tr,
				bg: GREEN,
				mainColor: WHITE,
				footerColor: WHITE,
				headerColor: WHITE,
			},
			{
				feedbackId: 'receiving_timecode',
				options: tr,
				isInverted: true,
				bg: RED,
				mainColor: WHITE,
				footerColor: WHITE,
				headerColor: WHITE,
			},
		]
		const timecodeIn = [
			textTile('tc_in', 'Timecode input', {
				header: `${hdr} · TC in ${v('tc_source')}`,
				main: v('tc_incoming'),
				mono: true,
				mainSize: 42,
				footer: v('tc_status'),
				feedbacks: tcFb,
			}),
			textTile('tc_match', 'Timecode matching indicator', {
				header: `${hdr} · timecode`,
				main: 'TC',
				mainSize: 70,
				footer: v('tc_match'),
				bg: PANEL,
				feedbacks: tcFb,
			}),
			digit('tc_hh', 'Timecode input: hours', `${hdr} · TC h`, 'tc_incoming_hh', { feedbacks: tcFb }),
			digit('tc_mm', 'Timecode input: minutes', `${hdr} · TC m`, 'tc_incoming_mm', { feedbacks: tcFb }),
			digit('tc_ss', 'Timecode input: seconds', `${hdr} · TC s`, 'tc_incoming_ss', { feedbacks: tcFb }),
			digit('tc_ff', 'Timecode input: frames', `${hdr} · TC f`, 'tc_incoming_ff', { feedbacks: tcFb }),
		]

		const cues = [
			textTile('goto_cue', 'Go to cue (edit the cue number)', {
				main: 'Cue 1',
				mainSize: 50,
				footer: 'go to cue tag',
				actionId: 'goto_cue',
				options: {
					text: '1',
					kind: 'tag:CUE',
					match: 'exact',
					otherTracks: true,
					playmode: 'NotSet',
				},
				feedbacks: [
					{
						feedbackId: 'cue_is',
						options: { ...tr, text: '1', match: 'exact' },
						bg: BLUE,
					},
				],
			}),
			textTile('goto_note', 'Go to note (edit the text)', {
				main: 'Note',
				mainSize: 50,
				footer: 'go to note',
				actionId: 'goto_cue',
				options: {
					text: 'Note',
					kind: 'note',
					match: 'exact',
					otherTracks: true,
					playmode: 'NotSet',
				},
				feedbacks: [
					{
						feedbackId: 'cue_is',
						options: { ...tr, text: 'Note', match: 'exact' },
						bg: BLUE,
					},
				],
			}),
			textTile('goto_midi', 'Go to MIDI tag (edit the value)', {
				main: 'MIDI 1',
				mainSize: 50,
				footer: 'go to MIDI tag',
				actionId: 'goto_cue',
				options: {
					text: '1',
					kind: 'tag:MIDI',
					match: 'exact',
					otherTracks: true,
					playmode: 'NotSet',
				},
				feedbacks: [
					{
						feedbackId: 'cue_is',
						options: { ...tr, text: '1', match: 'exact' },
						bg: BLUE,
					},
				],
			}),
			textTile('goto_tc', 'Go to timecode tag (edit the value)', {
				main: '01:00:00:00',
				mono: true,
				mainSize: 40,
				footer: 'go to TC tag',
				actionId: 'goto_cue',
				options: {
					text: '01:00:00:00',
					kind: 'tag:TC',
					match: 'exact',
					otherTracks: true,
					playmode: 'NotSet',
				},
				feedbacks: [
					{
						feedbackId: 'cue_is',
						options: { ...tr, text: '01:00:00:00', match: 'exact' },
						bg: BLUE,
					},
				],
			}),
			textTile('section_back', 'Section back (delta editable)', {
				main: '◀ 1',
				mainSize: 60,
				footer: 'section back',
				actionId: 'section_relative',
				options: { delta: '-1', playmode: 'NotSet' },
			}),
			textTile('section_forward', 'Section forward (delta editable)', {
				main: '1 ▶',
				mainSize: 60,
				footer: 'section forward',
				actionId: 'section_relative',
				options: { delta: '1', playmode: 'NotSet' },
			}),
		]

		const levels = [
			textTile('volume', 'Volume (rotary: ±1 %, press: 100 %)', {
				header: `${hdr} · volume`,
				main: `${v('volume')} %`,
				mainSize: 50,
				footer: 'turn ±1 · press 100',
				gauge: { expr: g(`${key}_volume`), color: AMBER },
				actionId: 'set_volume',
				options: { value: '100' },
				rotate: {
					left: [{ actionId: 'adjust_volume', options: { ...tr, value: '-1' } }],
					right: [{ actionId: 'adjust_volume', options: { ...tr, value: '1' } }],
				},
			}),
			textTile('vol_up', 'Volume +5 %', {
				header: `${hdr} · volume`,
				main: '+',
				mainSize: 70,
				footer: `${v('volume')} %`,
				gauge: { expr: g(`${key}_volume`), color: AMBER },
				actionId: 'adjust_volume',
				options: { value: '5' },
			}),
			textTile('vol_down', 'Volume −5 %', {
				header: `${hdr} · volume`,
				main: '−',
				mainSize: 70,
				footer: `${v('volume')} %`,
				gauge: { expr: g(`${key}_volume`), color: AMBER },
				actionId: 'adjust_volume',
				options: { value: '-5' },
			}),
			textTile('vol_mute', 'Volume 0 %', {
				header: `${hdr} · volume`,
				main: '0 %',
				mainSize: 50,
				footer: `now ${v('volume')} %`,
				actionId: 'set_volume',
				options: { value: '0' },
			}),
			textTile('brightness', 'Brightness (rotary: ±1 %, press: 100 %)', {
				header: `${hdr} · brightness`,
				main: `${v('brightness')} %`,
				mainSize: 50,
				footer: 'turn ±1 · press 100',
				gauge: { expr: g(`${key}_brightness`), color: WHITE },
				actionId: 'set_brightness',
				options: { value: '100' },
				rotate: {
					left: [{ actionId: 'adjust_brightness', options: { ...tr, value: '-1' } }],
					right: [{ actionId: 'adjust_brightness', options: { ...tr, value: '1' } }],
				},
			}),
			textTile('bright_up', 'Brightness +5 %', {
				header: `${hdr} · brightness`,
				main: '+',
				mainSize: 70,
				footer: `${v('brightness')} %`,
				gauge: { expr: g(`${key}_brightness`), color: WHITE },
				actionId: 'adjust_brightness',
				options: { value: '5' },
			}),
			textTile('bright_down', 'Brightness −5 %', {
				header: `${hdr} · brightness`,
				main: '−',
				mainSize: 70,
				footer: `${v('brightness')} %`,
				gauge: { expr: g(`${key}_brightness`), color: WHITE },
				actionId: 'adjust_brightness',
				options: { value: '-5' },
			}),
			textTile('bright_black', 'Brightness 0 %', {
				header: `${hdr} · brightness`,
				main: '0 %',
				mainSize: 50,
				footer: `now ${v('brightness')} %`,
				actionId: 'set_brightness',
				options: { value: '0' },
			}),
		]

		const definitions = [
			{
				id: `t_${key}_control`,
				type: 'simple',
				name: 'Control',
				presets: control,
			},
			{
				id: `t_${key}_displays`,
				type: 'simple',
				name: 'Displays and warnings',
				presets: displays,
			},
			{
				id: `t_${key}_digits`,
				type: 'simple',
				name: 'Big digits (time, next section in)',
				presets: digits,
			},
			{
				id: `t_${key}_timecode`,
				type: 'simple',
				name: 'Transport timecode input',
				presets: timecodeIn,
			},
			{
				id: `t_${key}_cues`,
				type: 'simple',
				name: 'Cues and jumps',
				presets: cues,
			},
			{
				id: `t_${key}_levels`,
				type: 'simple',
				name: 'Volume and brightness',
				presets: levels,
			},
		]

		// a multitransport is only a bundle of transports: time, cues, levels and timecode belong to its members
		if (kind === 'multi') definitions.splice(1)

		if (kind === 'active') {
			const layerTypes = [
				'VariableVideo',
				'Audio',
				'Mtc',
				'PlayMode',
				'TrackJump',
				'IgnoreTimecode',
				'MidiNote',
				'Open',
				'Colour',
				'TestPattern',
				'Radar',
			]
			const newLayers = layerTypes.map((type) => {
				const title = instance.layerTypeName(type)
				return p(
					`layer_add_${type.toLowerCase()}`,
					tile({
						name: `New ${title} layer at the playhead`,
						header: `${hdr} · new layer`,
						main: title,
						mainSize: 46,
						footer: 'until next section',
						bg: PANEL,
						actions: [
							{
								actionId: 'layer_add',
								options: {
									type,
									name: '',
									length: '10',
									toSectionEnd: true,
									start: '',
								},
							},
						],
					}),
				)
			})
			const clipboard = [
				p(
					'layer_sel_duplicate',
					tile({
						name: 'Duplicate the selected layers',
						header: `${hdr} · selection`,
						main: 'Duplicate',
						mainSize: 44,
						footer: g('selected_layers'),
						bg: PANEL,
						actions: [{ actionId: 'layer_selected', options: { op: 'duplicate' } }],
					}),
				),
				p(
					'layer_sel_copy',
					tile({
						name: 'Copy the selected layers',
						header: `${hdr} · selection`,
						main: 'Copy',
						mainSize: 50,
						footer: g('selected_layers'),
						bg: PANEL,
						actions: [{ actionId: 'layer_selected', options: { op: 'copy' } }],
					}),
				),
				p(
					'layer_sel_cut',
					tile({
						name: 'Cut the selected layers',
						header: `${hdr} · selection`,
						main: 'Cut',
						mainSize: 50,
						footer: g('selected_layers'),
						bg: PANEL,
						actions: [{ actionId: 'layer_selected', options: { op: 'cut' } }],
					}),
				),
				p(
					'layer_sel_paste',
					tile({
						name: 'Paste at the playhead',
						header: `${hdr} · selection`,
						main: 'Paste',
						mainSize: 50,
						footer: `at ${v('time_tc')}`,
						bg: PANEL,
						actions: [{ actionId: 'layer_selected', options: { op: 'paste' } }],
					}),
				),
			]
			const sel = (suffix, presetName, main, footer, actionId, options, mainSize = 44) =>
				p(
					suffix,
					tile({
						name: presetName,
						header: `${hdr} · selected layer`,
						main,
						mainSize,
						footer,
						bg: PANEL,
						actions: [{ actionId, options }],
					}),
				)
			const layerControl = [
				sel(
					'layer_fit',
					'Fit the selected layer to its content length',
					'Fit to content',
					g('selected_layers'),
					'layer_fit',
					{},
					40,
				),
				...Object.entries(LAYER_PROPERTIES).flatMap(([id, prop]) => [
					sel(
						`layer_fade_in_${id}`,
						`${prop.label}: fade in 1 s at the layer start`,
						'Fade in',
						`${prop.label.toLowerCase()} ${prop.min} → ${prop.max}`,
						'layer_fade',
						{
							property: id,
							anchor: 'start',
							from: String(prop.min),
							to: String(prop.max),
							seconds: '1',
						},
					),
					sel(
						`layer_fade_out_${id}`,
						`${prop.label}: fade out 1 s at the layer end`,
						'Fade out',
						`${prop.label.toLowerCase()} ${prop.max} → ${prop.min}`,
						'layer_fade',
						{
							property: id,
							anchor: 'end',
							from: String(prop.max),
							to: String(prop.min),
							seconds: '1',
						},
					),
					sel(
						`layer_fade_here_${id}`,
						`${prop.label}: fade in 1 s at the playhead`,
						'Fade here',
						`${prop.label.toLowerCase()} at playhead`,
						'layer_fade',
						{
							property: id,
							anchor: 'playhead',
							from: String(prop.min),
							to: String(prop.max),
							seconds: '1',
						},
					),
					sel(
						`layer_keys_clear_${id}`,
						`${prop.label}: clear keyframes`,
						'Clear keys',
						`${prop.label.toLowerCase()} static ${prop.max}`,
						'layer_keys_clear',
						{ property: id, value: String(prop.max) },
					),
				]),
				sel(
					'layer_blendmode',
					'Assign blend mode – pick the mode on the button',
					'Assign blend mode',
					'pick the mode in the action',
					'layer_blendmode',
					{ mode: 'Over' },
					38,
				),
				sel(
					'layer_mapping',
					'Assign mapping – pick the mapping on the button',
					'Assign mapping',
					'pick the mapping in the action',
					'layer_mapping',
					{ mapping: instance.mappings[0] || '' },
					40,
				),
				sel('layer_playmode_normal', 'Play mode Normal', 'Normal', 'play mode', 'layer_playmode', { mode: 'Normal' }),
				sel('layer_playmode_locked', 'Play mode Locked', 'Locked', 'play mode', 'layer_playmode', { mode: 'Locked' }),
				sel('layer_end_loop', 'At end point: Loop', 'Loop', 'at end point', 'layer_endpoint', { mode: 'Loop' }),
				sel('layer_end_pause', 'At end point: Pause', 'Pause', 'at end point', 'layer_endpoint', { mode: 'Pause' }),
				sel(
					'layer_end_pingpong',
					'At end point: Ping-pong',
					'Ping-pong',
					'at end point',
					'layer_endpoint',
					{ mode: 'Ping-pong' },
					40,
				),
			]
			const sec = (suffix, presetName, main, footer, actionId, options, mainSize = 46) =>
				p(
					suffix,
					tile({
						name: presetName,
						header: `${hdr} · section`,
						main,
						mainSize,
						footer,
						bg: PANEL,
						actions: [{ actionId, options }],
					}),
				)
			const notes = [
				p(
					'note_take',
					tile({
						name: 'Take note (text, target and prefix on the button; default: note of the current track)',
						header: `${hdr} · notes`,
						main: 'Take note',
						mainSize: 44,
						footer: 'current track | timecode',
						bg: PANEL,
						actions: [
							{
								actionId: 'note_append',
								options: {
									target: 'track',
									text: 'Check this',
									parts: ['timecode'],
								},
							},
						],
					}),
				),
			]
			const sections = [
				sec(
					'section_split',
					'Section: split at the playhead',
					'Split',
					`at ${v('time_tc')}`,
					'section_split',
					{ op: 'split' },
					50,
				),
				sec(
					'section_merge',
					'Section: merge at the playhead',
					'Merge',
					`at ${v('time_tc')}`,
					'section_split',
					{ op: 'merge' },
					50,
				),
				sec('tag_cue', 'Add cue tag at the playhead (edit the value)', 'CUE 1', 'add cue tag', 'add_annotation', {
					kind: 'cue',
					text: '1',
				}),
				sec('tag_midi', 'Add MIDI tag at the playhead (edit the value)', 'MIDI 1', 'add MIDI tag', 'add_annotation', {
					kind: 'midi',
					text: '1',
				}),
				sec(
					'tag_tc',
					'Add timecode tag at the playhead (edit the value)',
					'01:00:00:00',
					'add TC tag',
					'add_annotation',
					{ kind: 'tc', text: '01:00:00:00' },
					34,
				),
				sec('note_add', 'Add note at the playhead (edit the text)', 'Note', 'add note', 'add_annotation', {
					kind: 'note',
					text: 'Note',
				}),
				sec(
					'crossfade_fade',
					'Crossfade of the current section: fade 1 s',
					'Fade 1 s',
					'section crossfade',
					'section_crossfade',
					{ mode: 'fade', seconds: '1', loop: false },
				),
				sec(
					'crossfade_loop',
					'Crossfade of the current section: fade 1 s with loop crossfade',
					'Fade loop',
					'section crossfade',
					'section_crossfade',
					{ mode: 'fade', seconds: '1', loop: true },
				),
				sec(
					'crossfade_undefined',
					'Crossfade of the current section: undefined',
					'Undefined',
					'section crossfade',
					'section_crossfade',
					{ mode: 'undefined', seconds: '1', loop: false },
					40,
				),
				sec(
					'insert_time',
					'Insert 5 s at the playhead (move layers)',
					'+5 s',
					'insert time',
					'insert_time',
					{ seconds: '5', layers: 'move', remove: false },
					56,
				),
				sec(
					'remove_time',
					'Remove 5 s at the playhead (move layers)',
					'−5 s',
					'remove time',
					'insert_time',
					{ seconds: '5', layers: 'move', remove: true },
					56,
				),
			]
			definitions.push(
				{
					id: `t_${key}_new_layers`,
					type: 'simple',
					name: 'New layers',
					presets: newLayers,
				},
				{
					id: `t_${key}_clipboard`,
					type: 'simple',
					name: 'Layer clipboard (duplicate, copy, cut, paste)',
					presets: clipboard,
				},
				{
					id: `t_${key}_layer_control`,
					type: 'simple',
					name: 'Selected layer (fit, fade, assign)',
					presets: layerControl,
				},
				{
					id: `t_${key}_sections`,
					type: 'simple',
					name: 'Sections, tags, time',
					presets: sections,
				},
				{
					id: `t_${key}_notes`,
					type: 'simple',
					name: 'Notes (note taking)',
					presets: notes,
				},
			)
		}

		const groupName =
			kind === 'active' ? 'Active transport' : kind === 'multi' ? `Multitransport: ${name}` : `Transport: ${name}`
		structure.push({
			id: `t_${key}`,
			name: groupName,
			description:
				kind === 'active'
					? 'Follows whichever transport is active in Designer. Layer and section editing works here only.'
					: undefined,
			definitions,
		})
	}

	// drop presets that no group references (e.g. the display tiles built for multitransports)
	const referenced = new Set(
		structure.flatMap((sec) => sec.definitions.flatMap((d) => (typeof d === 'string' ? [d] : d.presets || []))),
	)
	for (const id of Object.keys(presets)) if (!referenced.has(id)) delete presets[id]
	return { structure, presets }
}

module.exports = { getPresetDefinitions, tile }
