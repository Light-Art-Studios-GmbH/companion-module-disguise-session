/**
 * @file Connection configuration fields.
 *
 * Config keys:
 *   host           Director IP or hostname (the session API listens on port 80, no authentication)
 *   host2          optional second machine (understudy / backup Director)
 *   host3          optional editor machine (selected with the "Connection: use host" action)
 *   follow         follow the Director automatically: commands go to whichever machine currently is the Director
 *   port           HTTP port of the session API (default 80)
 *   warnSeconds    threshold used by the warning presets (seconds before the next section / end of track)
 *   cacheAllTracks also load the annotations of tracks that are not on a transport (cue search across tracks)
 */
const { Regex } = require('@companion-module/base')

/**
 * @returns {import('@companion-module/base').SomeCompanionConfigField[]}
 */
function getConfigFields() {
	return [
		{
			id: 'info',
			type: 'static-text',
			label: 'Information',
			width: 12,
			value:
				'Controls a disguise Designer session through its session API (REST and Live Update on the Director). ' +
				'Enter the Director; a backup Director and an editor are optional. The session API only answers while Designer is running.',
		},
		{
			id: 'host',
			type: 'textinput',
			label: 'Director IP / hostname',
			width: 6,
			default: '',
			regex: Regex.HOSTNAME,
			tooltip: 'e.g. 192.168.1.10 – the machine running Designer as Director',
		},
		{
			id: 'host2',
			type: 'textinput',
			label: 'Understudy / backup Director (optional)',
			width: 6,
			default: '',
			tooltip:
				'Second machine of the session. Both are watched; with "Follow the Director" commands go to whichever machine currently is the Director.',
		},
		{
			id: 'host3',
			type: 'textinput',
			label: 'Editor (optional)',
			width: 6,
			default: '',
			tooltip:
				'A Designer editor of the same session. Use the action "Connection: use host" to control the editor instead of the Director; following the Director is paused while the editor is selected.',
		},
		{
			id: 'follow',
			type: 'checkbox',
			label: 'Follow the Director automatically (switch to the machine that reports itself as Director)',
			width: 8,
			default: true,
		},
		{
			id: 'port',
			type: 'number',
			label: 'HTTP port',
			width: 4,
			default: 80,
			min: 1,
			max: 65535,
		},
		{
			id: 'warnSeconds',
			type: 'number',
			label: 'Warning threshold for presets (seconds)',
			width: 4,
			default: 10,
			min: 1,
			max: 3600,
			tooltip:
				'The "remaining" presets turn orange (blinking) this many seconds before the next section / the end of the track.',
		},
		{
			id: 'cacheAllTracks',
			type: 'checkbox',
			label: 'Read the cues of all tracks (cue search across tracks)',
			width: 4,
			default: true,
			tooltip:
				'Off: only the tracks currently on a transport are read. On: every track of the setlists, refreshed once a minute.',
		},
	]
}

module.exports = { getConfigFields }
