/**
 * @file Companion connection instance of the Disguise Designer Control module.
 *
 * Data flow
 * ─────────
 * • REST (DisguiseApi): session/project info, transports, multitransports, tracks, annotations (sections, notes,
 *   tags) and health. Re-read every `pollSeconds` (new sections/notes appear after that time) and after a
 *   track change.
 * • Live Update (LiveUpdate websocket): playhead, playing, play mode, engaged, speed, volume, brightness,
 *   current track, timecode format and status – at `updateMs` per transport. Every update recomputes the
 *   derived values (section, elapsed/remaining, next cue …) and publishes the variables of that transport;
 *   the same values are mirrored to `active_*` and to the multitransports the transport belongs to.
 * • Commands go through REST; the Director confirms state changes via Live Update within one interval.
 *
 * Robustness: every callback is wrapped in `guard()`, `teardown()` is idempotent and nothing is processed
 * after `destroy()`.
 */
const { InstanceBase, InstanceStatus } = require('@companion-module/base')
const { getConfigFields } = require('./config.js')
const { getActionDefinitions } = require('./actions.js')
const { getFeedbackDefinitions } = require('./feedbacks.js')
const { getVariableDefinitions, TRANSPORT_VARS, MACHINE_VARS } = require('./variables.js')
const { getPresetDefinitions } = require('./presets.js')
const { DisguiseApi, normalizePlayMode } = require('./api.js')
const {
	LiveUpdate,
	probeRole,
	roleOf,
	objectPathName,
	pyStr,
	TRANSPORT_PROPS,
	GLOBAL_PROPS,
	D3,
} = require('./liveupdate.js')
const cuelist = require('./cuelist.js')
const { propertyOf } = require('./layer-properties.js')
const tc = require('./timecode.js')

const REQUEST_TIMEOUT_MS = 4000
/** Session structure (transports, tracks, annotations, health) is re-read via REST at this interval. */
const POLL_MS = 10000
/** Live Update interval: 40 ms = 25 updates/s, frame-accurate timecode variables. */
const LIVE_UPDATE_MS = 40
/** Live Update playMode.state → API play mode (verified on r34). */
const STATE_TO_MODE = { 0: 'Play', 1: 'PlaySection', 2: 'Loop', 3: 'Stop' }
const STATE_FEEDBACKS = [
	'playmode',
	'playing',
	'engaged',
	'track_is',
	'receiving_timecode',
	'timecode_matching',
	'tc_source_is',
]
const POSITION_FEEDBACKS = ['section_is', 'next_section_is', 'cue_is', 'next_cue_is']
const TIMED_FEEDBACKS = ['remaining_below', 'track_remaining_below']
const MASTER_OUTPUT = { 0: 'Fade down', 1: 'Fade up', 2: 'Hold' }
const MASTER_OUTPUT_IDS = { fadedown: 0, fadeup: 1, hold: 2 }
/** Blink period for warning feedbacks. */
const BLINK_MS = 500
/** Role probes of both hosts are refreshed this often. */
const HOST_CHECK_MS = 5000
/** How often time-threshold feedbacks are re-evaluated while the playhead runs. */
const TIMED_CHECK_MS = 250
/** Annotations of tracks that are not on a transport are refreshed this often (when cacheAllTracks is on). */
const ALL_TRACKS_REFRESH_MS = 60000
/** Reserved variable prefix for the active transport. */
const ACTIVE_KEY = 'active'

/**
 * @typedef {object} TransportState
 * @property {string} uid
 * @property {string} name
 * @property {string} key variable prefix
 * @property {boolean} engaged
 * @property {number} volume 0..1
 * @property {number} brightness 0..1
 * @property {string} playmode Play | PlaySection | Loop | Stop
 * @property {boolean} playing
 * @property {number} time playhead seconds
 * @property {string} trackUid
 * @property {string} trackName
 * @property {boolean} receivingTimecode
 * @property {string} tcStatus
 * @property {string} tcSource timecode source type (MTC, LTC, …)
 * @property {string} tcIncoming incoming timecode text
 * @property {number} tcIncomingSeconds incoming timecode in seconds (-1 = none)
 * @property {tc.Clock|undefined} smpteClock timecode format reported by the Director
 * @property {tc.Clock|undefined} rateClock timeline refresh rate (fallback)
 * @property {number} lastFrame
 * @property {string} lastPosKey
 */

class DisguiseInstance extends InstanceBase {
	/** [class without "Module", Designer name] – the common layer types, in menu order. */
	static DEFAULT_LAYER_TYPES = [
		['VariableVideo', 'Video'],
		['Audio', 'Audio'],
		['Mtc', 'MTC'],
		['PlayMode', 'Play Mode'],
		['TrackJump', 'Track Jump'],
		['IgnoreTimecode', 'Timecode Mode'],
		['MidiNote', 'Midi Note'],
		['Open', 'Open'],
		['Colour', 'Colour'],
		['TestPattern', 'Test Pattern'],
		['Radar', 'Radar'],
		['Bitmap', 'Bitmap'],
		['Gradient', 'Gradient'],
		['Text', 'Text'],
		['Notch', 'Notch'],
		['Web', 'Web'],
		['RenderStream', 'Render Stream'],
		['Video', 'Video (classic)'],
	]

	constructor(internal) {
		super(internal)
		/** @type {Record<string, any>} */
		this.config = {}
		/** @type {DisguiseApi|null} */
		this.api = null
		/** @type {LiveUpdate|null} */
		this.live = null
		this.destroyed = false
		this.session = { connected: false, director: '', version: '', mode: '' }
		this.health = { dropped: 0 }
		/** @type {Map<string, {key:string, name:string, hostname:string, uid:string, role:string, fps:number, dropped:number, state:string, problems:string, notifications:string[]}>} */
		this.machines = new Map()
		/** Director-wide values from Live Update. */
		this.master = { output: -1, fadeDuration: 0 }
		this.failover = { preset: '', pairs: [], pairsSig: '' }
		/** @type {{id:string, name:string}[]} Designer module classes (without "Module") with Designer's display names */
		this.layerTypes = []
		/** @type {string[]} mapping (projection) names of the project */
		this.mappings = []
		/** @type {string[]} note lists (Designer Note resources) of the project */
		this.noteLists = []
		/** @type {string[]} blend mode names in Designer's order (index = value) */
		this.blendModes = []
		this.projectName = ''
		/** Hosts: the configured Director and the optional backup. */
		this.hosts = { primary: DisguiseInstance.newHost(''), backup: null, editor: null }
		/** @type {Map<string, {dropped:number, problems:string, notifications:string[]}>} acknowledged alert baseline per machine */
		this.machineAck = new Map()
		this.gui = { transport: '', selectedLayers: [] }
		/** lockedToDirector of the machine the commands go to (meaningful on an editor) */
		this.editor = { locked: true }
		/** @type {{mode:'copy'|'cut', names:string[], track:string}|null} */
		this.layerClip = null
		this.activeHostKey = 'primary'
		this.lastHostCheck = 0
		this.switching = false
		this.blinkTimer = null
		this.blinkOn = false
		/** @type {Map<string, TransportState>} uid → transport */
		this.transports = new Map()
		/** @type {Map<string, {uid:string, name:string, key:string, engaged:boolean, members:string[]}>} */
		this.multis = new Map()
		/** @type {Map<string, {uid:string, name:string, length:number}>} */
		this.tracks = new Map()
		/** @type {Map<string, cuelist.CueItem[]>} track uid → cuelist */
		this.cuelists = new Map()
		this.activeUid = ''
		this.pollTimer = null
		/** @type {Promise<void>|null} */
		this.refreshing = null
		this.lastAllTracksLoad = 0
		this.lastTimedCheck = 0
		this.definitionSignature = ''
		/** Live-update error messages already logged (each once). @type {Set<string>} */
		this.loggedLiveErrors = new Set()
	}

	// ────────────────────────────────────────────────────────────── lifecycle

	async init(config) {
		this.config = config || {}
		this.destroyed = false
		await this.start()
	}

	async configUpdated(config) {
		this.teardown()
		this.config = config || {}
		await this.start()
	}

	async destroy() {
		this.destroyed = true
		this.teardown()
	}

	getConfigFields() {
		return getConfigFields()
	}

	async start() {
		this.rebuildDefinitions(true)
		this.publishGlobals()
		const host = String(this.config.host || '').trim()
		const host2 = String(this.config.host2 || '').trim()
		const host3 = String(this.config.host3 || '').trim()
		this.hosts = {
			primary: DisguiseInstance.newHost(host),
			backup: host2 && host2 !== host ? DisguiseInstance.newHost(host2) : null,
			editor: host3 && host3 !== host && host3 !== host2 ? DisguiseInstance.newHost(host3) : null,
		}
		this.activeHostKey = 'primary'
		if (!host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Director host missing')
			return
		}
		this.updateStatus(InstanceStatus.Connecting, `Connecting to ${host} …`)
		this.useHost(this.activeHostKey)
		await this.refreshSession(true)
		this.pollTimer = setInterval(() => this.guard('poll', () => this.refreshSession(false)), POLL_MS)
		this.blinkTimer = setInterval(() => this.guard('blink', () => this.tickBlink()), BLINK_MS)
	}

	/** @param {string} host */
	static newHost(host) {
		return {
			host,
			reachable: false,
			machine: '',
			director: '',
			isDirector: false,
			state: host ? 'unknown' : 'not configured',
			lastError: '',
		}
	}

	/** @param {'primary'|'backup'|'editor'} key */
	hostByKey(key) {
		return key === 'backup' ? this.hosts.backup : key === 'editor' ? this.hosts.editor : this.hosts.primary
	}

	/** The host commands currently go to. */
	get activeHost() {
		const h = this.hostByKey(this.activeHostKey)
		return h ? h.host : ''
	}

	/**
	 * "Connection: use host" action.
	 * @param {unknown} which toggle | primary | backup | editor | director
	 */
	async useHostOption(which) {
		const w = String(which || 'toggle')
		if (w === 'editor') {
			if (!this.hosts.editor) throw new Error('no editor host configured')
			return this.switchHost('editor', 'manual')
		}
		if (w === 'director') {
			const key = this.hosts.backup?.isDirector && !this.hosts.primary.isDirector ? 'backup' : 'primary'
			return this.switchHost(key, 'manual: back to the Director')
		}
		if (w === 'toggle') return this.switchHost(this.activeHostKey === 'backup' ? 'primary' : 'backup', 'manual')
		return this.switchHost(w === 'backup' ? 'backup' : 'primary', 'manual')
	}

	/**
	 * Creates the REST client and the Live Update connection for one of the configured hosts.
	 * @param {'primary'|'backup'|'editor'} key
	 */
	useHost(key) {
		if (this.live) this.live.stop()
		this.live = null
		this.api = null
		this.activeHostKey = key
		const host = this.activeHost
		if (!host) return
		const port = Number(this.config.port) || 80
		const log = (l, m) => this.log(l, m)
		this.api = new DisguiseApi({ host, port, timeoutMs: REQUEST_TIMEOUT_MS, log })
		const live = new LiveUpdate({ host, port, updateMs: LIVE_UPDATE_MS, log })
		live.on('update', (u) => this.guard('live update', () => this.onLive(u)))
		live.on('open', () => {
			this.log('info', `Live Update connected (${host})`)
			this.refreshStatus()
		})
		live.on('close', (reason) => {
			if (this.destroyed || this.live !== live) return
			if (this.session.connected) this.log('warn', `Live Update closed (${reason}), reconnecting …`)
			this.refreshStatus()
		})
		live.on('error', (msg) => {
			if (this.loggedLiveErrors.has(msg)) return
			this.loggedLiveErrors.add(msg)
			this.log('debug', msg)
		})
		this.live = live
		this.session.connected = false
		this.publishGlobals()
	}

	/**
	 * The transport shown in the editing GUI (falls back to the active transport) and its object path.
	 * @returns {{t: TransportState, objectPath: string}|undefined}
	 */
	editContext() {
		const byName = this.gui.transport
			? [...this.transports.values()].find((x) => x.name === this.gui.transport)
			: undefined
		const t = this.transports.get(this.activeUid) || byName || [...this.transports.values()][0]
		if (!t) return undefined
		return { t, objectPath: `transportmanager:${objectPathName(t.name)}` }
	}

	/** Transport that layer / section edits address: the one shown in the GUI, else the first target. @param {TransportState[]} targets */
	editTransport(targets) {
		return this.editContext()?.t || targets[0]
	}

	/** Object path for edits on the GUI transport (falls back to the given transport). @param {TransportState} t */
	editObjectPath(t) {
		return this.editContext()?.objectPath || `transportmanager:${objectPathName(t.name)}`
	}

	/**
	 * Switches commands and Live Update to the other configured host (Director failover).
	 * @param {'primary'|'backup'|'editor'} key
	 * @param {string} reason
	 */
	async switchHost(key, reason) {
		if (key === this.activeHostKey || this.switching) return
		const target = this.hostByKey(key)
		if (!target?.host) return
		this.switching = true
		try {
			this.log('warn', `Switching to ${key} host ${target.host} (${reason})`)
			this.useHost(key)
			this.updateStatus(InstanceStatus.Connecting, `Switching to ${target.host} …`)
			this.live?.start()
			await this.refreshSession(true)
			if (!this.session.connected)
				this.log(
					'error',
					`${target.host} did not answer – commands now go there anyway; use "Connection: use host" to go back`,
				)
			else this.log('info', `Commands now go to ${target.host} (${this.hostByKey(key)?.machine || key})`)
			this.publishGlobals()
			this.checkFeedbacks('on_backup', 'on_editor', 'host_state', 'editor_locked')
		} finally {
			this.switching = false
		}
	}

	/** Live Update subscriptions: one group per transport plus the Director-wide group on the first transport. */
	syncLiveGroups() {
		if (!this.live) return
		const transports = [...this.transports.values()]
		const groups = transports.map((t) => ({
			tag: 'transport',
			objectPath: `transportmanager:${objectPathName(t.name)}`,
			props: TRANSPORT_PROPS,
		}))
		if (transports.length)
			groups.push({
				tag: 'global',
				objectPath: `transportmanager:${objectPathName(transports[0].name)}`,
				props: GLOBAL_PROPS,
				updateMs: 1000,
			})
		this.live.setGroups(groups)
		this.live.start()
	}

	/** Object path used for Director-wide expressions (any existing transport). */
	anyObjectPath() {
		const t = this.transports.get(this.activeUid) || [...this.transports.values()][0]
		return `transportmanager:${objectPathName(t ? t.name : 'default')}`
	}

	/** Toggles the blink phase and re-evaluates the warning feedbacks (they blink even when the playhead is stopped). */
	tickBlink() {
		this.blinkOn = !this.blinkOn
		this.checkFeedbacks(...TIMED_FEEDBACKS)
	}

	/** Stops timers and sockets. Safe to call twice. */
	teardown() {
		if (this.pollTimer) clearInterval(this.pollTimer)
		this.pollTimer = null
		if (this.blinkTimer) clearInterval(this.blinkTimer)
		this.blinkTimer = null
		if (this.failoverTimer) clearTimeout(this.failoverTimer)
		this.failoverTimer = null
		if (this.live) {
			this.live.removeAllListeners()
			this.live.stop()
		}
		this.live = null
		this.api = null
		this.session.connected = false
	}

	/**
	 * Runs `fn` and turns exceptions into log lines instead of a crashed module process.
	 * @template T
	 * @param {string} what
	 * @param {() => T} fn
	 */
	guard(what, fn) {
		if (this.destroyed) return undefined
		try {
			const r = fn()
			if (r && typeof r.then === 'function')
				r.catch((e) => this.log('error', `Internal error in ${what}: ${e?.stack || e}`))
			return r
		} catch (e) {
			this.log('error', `Internal error in ${what}: ${e?.stack || e?.message || e}`)
			return undefined
		}
	}

	/**
	 * Runs a command with error logging (used by the actions).
	 * @param {string} what
	 * @param {() => Promise<unknown>} fn
	 */
	async run(what, fn) {
		if (!this.api) {
			this.log('warn', `${what}: not connected`)
			return
		}
		this.log('debug', what)
		try {
			await fn()
		} catch (e) {
			this.log('error', `${what}: ${e?.message || e}`)
			if (/timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|fetch failed/i.test(String(e?.message)))
				this.guard('refresh after error', () => this.refreshSession(false))
		}
	}

	// ────────────────────────────────────────────────────────────── session (REST)

	/**
	 * Re-reads the session via REST. Concurrent calls share one run.
	 * @param {boolean} full also re-read project/session info and all tracks' annotations
	 * @param {boolean} [logIt] write a summary to the log (used by the "refresh" action)
	 */
	refreshSession(full, logIt = false) {
		if (this.refreshing) return this.refreshing
		const api = this.api
		if (!api || this.destroyed) return Promise.resolve()
		this.refreshing = (async () => {
			try {
				if (full || !this.session.connected) {
					const [project, session] = await Promise.all([api.getProject(), api.getSession()])
					this.sessionInfo = session
					this.projectName =
						String(project?.projectPath || '')
							.replace(/^.*[\\/]/, '')
							.replace(/\.d3$/i, '') || this.projectName
					const v = project?.version || {}
					this.session.version = v.major
						? `r${v.major}.${v.minor}${v.hotfix ? '.' + v.hotfix : ''}${v.releaseType ? ' ' + v.releaseType : ''}`
						: ''
					this.session.director = session?.director?.name || ''
					const actors = Array.isArray(session?.actors) ? session.actors.length : 0
					const understudies = Array.isArray(session?.understudies) ? session.understudies.length : 0
					this.session.mode = session?.isRunningSolo
						? 'Solo'
						: `Director + ${actors} actor${actors === 1 ? '' : 's'}${understudies ? ` + ${understudies} understud${understudies === 1 ? 'y' : 'ies'}` : ''}`
				}
				const [{ transports, multitransports }, active, tracks] = await Promise.all([
					api.getTransports(),
					api.getActiveTransport().catch(() => undefined),
					api.getTracks().catch(() => []),
				])
				this.applyTracks(tracks)
				this.applyTransports(transports, multitransports, active)
				await this.loadAnnotations(full)
				await this.loadHealth()
				const wasConnected = this.session.connected
				// failover settings/pairs: on full refreshes, after every (re)connect and every ~30 s in between
				this.failoverPollCount = (this.failoverPollCount || 0) + 1
				if (full || !wasConnected || this.failoverPollCount % 6 === 0) await this.loadFailover()
				this.session.connected = true
				if (!wasConnected) {
					this.log(
						'info',
						`Connected to ${this.session.director || this.config.host} (Designer ${this.session.version}, ${this.session.mode}): ` +
							`${this.transports.size} transport(s), ${this.multis.size} multitransport(s), ${this.tracks.size} track(s)`,
					)
				}
				if (logIt) {
					this.log(
						'info',
						`Session: transports ${[...this.transports.values()].map((t) => t.name).join(', ') || '–'}; ` +
							`multitransports ${[...this.multis.values()].map((m) => `${m.name} [${m.members.length}]`).join(', ') || '–'}; ` +
							`tracks ${[...this.tracks.values()].map((t) => t.name).join(', ') || '–'}`,
					)
				}
				this.syncLiveGroups()
				this.refreshStatus()
				this.publishGlobals()
				this.publishMachines()
				for (const t of this.transports.values()) this.publishTransport(t, true)
				this.checkFeedbacks(
					'connected',
					...STATE_FEEDBACKS,
					...POSITION_FEEDBACKS,
					...TIMED_FEEDBACKS,
					'dropped_frames',
					'machine_health',
					'master_output',
				)
			} catch (e) {
				const msg = e?.message || String(e)
				if (this.session.connected || full) this.log('error', `${this.activeHost}: not reachable: ${msg}`)
				this.session.connected = false
				this.updateStatus(InstanceStatus.ConnectionFailure, msg)
				this.publishGlobals()
				this.checkFeedbacks('connected')
			} finally {
				this.refreshing = null
			}
			await this.checkHosts()
		})()
		return this.refreshing
	}

	/**
	 * Probes both configured hosts (reachability and role) and, with "follow" enabled, moves to the machine
	 * that currently is the Director.
	 */
	async checkHosts() {
		if (this.destroyed || this.switching) return
		const now = Date.now()
		if (now - this.lastHostCheck < HOST_CHECK_MS) return
		this.lastHostCheck = now
		const port = Number(this.config.port) || 80
		const objectPath = this.anyObjectPath()
		const probe = async (h) => {
			if (!h?.host) return
			try {
				const role = await probeRole({ host: h.host, port, objectPath, timeoutMs: 3000 })
				h.reachable = true
				h.machine = role.machine
				h.director = role.director
				h.isDirector = role.isDirector
				h.state = role.role
				h.flags = {
					directorMode: role.role === 'director',
					editorMode: role.role === 'editor',
					actorMode: role.role === 'actor',
				}
				if (h.locked !== role.locked) {
					h.locked = role.locked
					this.checkFeedbacks('editor_locked')
				}
				h.lastError = ''
			} catch (e) {
				// REST may still answer – count the host as offline only if REST fails too
				try {
					const api = new DisguiseApi({ host: h.host, port, timeoutMs: 2500 })
					await api.getProject()
					h.reachable = true
					if (!h.state || h.state === 'offline' || h.state === 'unknown') h.state = 'online'
					h.lastError = `Live Update: ${e?.message || e}`
				} catch (e2) {
					h.reachable = false
					h.isDirector = false
					h.state = 'offline'
					h.lastError = e2?.message || String(e2)
				}
			}
		}
		await Promise.all([probe(this.hosts.primary), probe(this.hosts.backup), probe(this.hosts.editor)])
		// understudies carry no d3NetManager flag – take the role from the session list
		const understudies = new Set((this.sessionInfo?.understudies || []).map((u) => String(u?.name || '').toLowerCase()))
		for (const h of [this.hosts.primary, this.hosts.backup, this.hosts.editor]) {
			if (h?.reachable && h.state === 'online' && understudies.has(String(h.machine || '').toLowerCase()))
				h.state = 'understudy'
		}
		const primary = this.hosts.primary
		const backup = this.hosts.backup
		if (backup?.host && this.config.follow !== false && this.activeHostKey !== 'editor') {
			const active = this.activeHostKey === 'backup' ? backup : primary
			const other = this.activeHostKey === 'backup' ? primary : backup
			const otherKey = this.activeHostKey === 'backup' ? 'primary' : 'backup'
			if (!active.isDirector && other.reachable && other.isDirector)
				await this.switchHost(otherKey, `${other.host} reports itself as Director`)
			else if (!active.reachable && other.reachable) await this.switchHost(otherKey, `${active.host} is offline`)
			else if (this.activeHostKey === 'backup' && primary.reachable && primary.isDirector && !backup.isDirector)
				await this.switchHost('primary', 'Director is back')
		}
		this.publishGlobals()
		this.checkFeedbacks('host_state', 'on_backup', 'on_editor')
	}

	/** Failover settings and understudy targets (REST, full refresh only). */
	async loadFailover() {
		const api = this.api
		if (!api) return
		try {
			const s = await api.getFailoverSettings()
			this.failover.preset = s.currentPreset || s.normalPreset
		} catch (e) {
			this.log('debug', `Failover settings: ${e?.message || e}`)
		}
		try {
			const t = await api.getUnderstudyTargets()
			/** @type {{understudy:string, target:string, uid:string}[]} */
			this.failover.pairs = []
			for (const [understudy, v] of Object.entries(t)) {
				for (const x of v?.targets || []) {
					const name = typeof x === 'string' ? x : String(x?.name || x?.hostname || '')
					if (name)
						this.failover.pairs.push({
							understudy,
							target: name,
							uid: typeof x === 'string' ? '' : String(x?.uid || ''),
						})
				}
			}
			if (JSON.stringify(this.failover.pairs) !== this.failover.pairsSig) {
				this.failover.pairsSig = JSON.stringify(this.failover.pairs)
				this.rebuildDefinitions(false)
			}
		} catch (e) {
			this.log('debug', `Understudy targets: ${e?.message || e}`)
		}
	}

	/** Connection status from REST + Live Update state. */
	refreshStatus() {
		if (this.destroyed) return
		if (!this.session.connected) return
		if (this.live && !this.live.connected)
			this.updateStatus(InstanceStatus.UnknownWarning, 'REST ok, Live Update (websocket) not connected')
		else
			this.updateStatus(
				InstanceStatus.Ok,
				`${this.hostByKey(this.activeHostKey)?.machine || this.session.director || this.activeHost} (${this.activeHost}, ${this.hostByKey(this.activeHostKey)?.state || 'role?'}) · Designer ${this.session.version}`,
			)
	}

	/** @param {{uid:string,name:string,length:number}[]} tracks */
	applyTracks(tracks) {
		const next = new Map()
		for (const t of tracks || [])
			next.set(String(t.uid), { uid: String(t.uid), name: String(t.name ?? ''), length: Number(t.length) || 0 })
		// tracks referenced by transports but missing from /tracks (other setlists) stay known
		for (const t of this.transports.values()) {
			if (t.trackUid && !next.has(t.trackUid))
				next.set(t.trackUid, this.tracks.get(t.trackUid) || { uid: t.trackUid, name: t.trackName, length: 0 })
		}
		this.tracks = next
	}

	/**
	 * @param {any[]} transports
	 * @param {{uid:string,name:string,engaged?:boolean,transports:string[]}[]} multis
	 * @param {any} active
	 */
	applyTransports(transports, multis, active) {
		const seen = new Set()
		for (const raw of transports || []) {
			const uid = String(raw.uid)
			seen.add(uid)
			let t = this.transports.get(uid)
			if (!t) {
				t = DisguiseInstance.newTransport(uid, String(raw.name ?? ''))
				this.transports.set(uid, t)
			}
			t.name = String(raw.name ?? t.name)
			t.engaged = !!raw.engaged
			if (typeof raw.volume === 'number') t.volume = raw.volume
			if (typeof raw.brightness === 'number') t.brightness = raw.brightness
			if (raw.playmode) t.playmode = normalizePlayMode(raw.playmode) === 'NotSet' ? t.playmode : String(raw.playmode)
			if (typeof raw.speed === 'number') t.speed = raw.speed
			t.receivingTimecode = !!raw.receivingTimecode
			if (raw.currentTrack?.uid) {
				t.trackUid = String(raw.currentTrack.uid)
				t.trackName = String(raw.currentTrack.name ?? t.trackName)
				if (!this.tracks.has(t.trackUid)) this.tracks.set(t.trackUid, { uid: t.trackUid, name: t.trackName, length: 0 })
			}
			// tracks of the transport's setlist (length is needed for "remaining to end of track")
			for (const tr of raw.setList?.tracks || []) {
				const known = this.tracks.get(String(tr.uid))
				if (!known)
					this.tracks.set(String(tr.uid), {
						uid: String(tr.uid),
						name: String(tr.name ?? ''),
						length: Number(tr.length) || 0,
					})
				else if (!known.length && tr.length) known.length = Number(tr.length) || 0
			}
		}
		for (const uid of [...this.transports.keys()]) if (!seen.has(uid)) this.transports.delete(uid)

		const seenMulti = new Set()
		for (const raw of multis || []) {
			const uid = String(raw.uid)
			seenMulti.add(uid)
			const m = this.multis.get(uid) || { uid, name: '', key: '', engaged: false, members: [] }
			m.name = String(raw.name ?? '')
			m.engaged = !!raw.engaged
			m.members = (raw.transports || []).map(String).filter((x) => this.transports.has(x))
			this.multis.set(uid, m)
		}
		for (const uid of [...this.multis.keys()]) if (!seenMulti.has(uid)) this.multis.delete(uid)

		// Active transport: the transport shown in the Designer GUI (Live Update) is the authority. The REST
		// /transport/activetransport list is only a fallback for the very first refresh – it can contain several
		// transports (all "active" ones), in which case its first entry says nothing about the GUI selection.
		const byGui = this.gui.transport
			? [...this.transports.values()].find((x) => x.name === this.gui.transport)
			: undefined
		this.activeUid = byGui
			? byGui.uid
			: this.activeUid && this.transports.has(this.activeUid)
				? this.activeUid
				: active?.uid && this.transports.has(String(active.uid))
					? String(active.uid)
					: [...this.transports.keys()][0] || ''
		this.assignKeys()
		const signature = JSON.stringify([
			[...this.transports.values()].map((t) => [t.uid, t.key, t.name]),
			[...this.multis.values()].map((m) => [m.uid, m.key, m.name]),
			[...this.tracks.values()].map((t) => [t.uid, t.name]),
		])
		if (signature !== this.definitionSignature) {
			this.definitionSignature = signature
			this.rebuildDefinitions(false)
		}
	}

	/** @param {string} uid @param {string} name @returns {TransportState} */
	static newTransport(uid, name) {
		return {
			uid,
			name,
			key: '',
			engaged: false,
			volume: 1,
			brightness: 1,
			playmode: 'Stop',
			playing: false,
			time: 0,
			trackUid: '',
			trackName: '',
			receivingTimecode: false,
			tcStatus: '',
			tcSource: '',
			tcIncoming: '',
			tcIncomingSeconds: -1,
			smpteClock: undefined,
			rateClock: undefined,
			lastFrame: -1,
			lastPosKey: '',
		}
	}

	/** Variable prefixes: "IMAG Screens" → imag_screens; collisions get a numeric suffix; "active" is reserved. */
	assignKeys() {
		const used = new Set([ACTIVE_KEY])
		const keyFor = (name, fallback) => {
			let base = String(name || '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_+|_+$/g, '')
			if (!base) base = fallback
			let key = base
			let n = 2
			while (used.has(key)) key = `${base}_${n++}`
			used.add(key)
			return key
		}
		for (const t of this.transports.values()) t.key = keyFor(t.name, 'transport')
		for (const m of this.multis.values()) m.key = keyFor(m.name, 'multitransport')
	}

	/**
	 * Loads annotations (sections/notes/tags) of the tracks on transports; with `cacheAllTracks` also all other
	 * known tracks (on a full refresh and once a minute).
	 * @param {boolean} full
	 */
	async loadAnnotations(full) {
		const api = this.api
		if (!api) return
		const wanted = new Set([...this.transports.values()].map((t) => t.trackUid).filter(Boolean))
		const now = Date.now()
		if (this.config.cacheAllTracks !== false && (full || now - this.lastAllTracksLoad > ALL_TRACKS_REFRESH_MS)) {
			this.lastAllTracksLoad = now
			for (const uid of this.tracks.keys()) wanted.add(uid)
		}
		await Promise.all([...wanted].map((uid) => this.loadAnnotationsFor(uid)))
	}

	/** @param {string} trackUid */
	async loadAnnotationsFor(trackUid) {
		const api = this.api
		if (!api || !trackUid) return
		const track = this.tracks.get(trackUid) || { uid: trackUid, name: '' }
		try {
			const a = await api.getAnnotations(track)
			this.cuelists.set(trackUid, cuelist.buildCuelist(a))
		} catch (e) {
			this.log('debug', `Annotations of track ${track.name || trackUid}: ${e?.message || e}`)
		}
	}

	async loadHealth() {
		const api = this.api
		if (!api) return
		try {
			const [machines, notes] = await Promise.all([api.getHealth(), api.getNotifications().catch(() => [])])
			const roles = new Map()
			if (this.sessionInfo) {
				if (this.sessionInfo.director?.name) roles.set(this.sessionInfo.director.name, 'director')
				for (const a of this.sessionInfo.actors || []) if (a?.name) roles.set(a.name, 'actor')
				for (const u of this.sessionInfo.understudies || []) if (u?.name) roles.set(u.name, 'understudy')
			}
			const seen = new Set()
			const previousKeys = [...this.machines.keys()].join(',')
			for (const m of machines) {
				const name = String(m.machine?.name || m.machine?.hostname || '')
				if (!name) continue
				seen.add(name)
				const states = Array.isArray(m.status?.states) ? m.status.states : []
				const problems = states.filter((st) => String(st.severity || '').toLowerCase() !== 'ready')
				const rank = { ready: 0, info: 1, warning: 2, error: 3, critical: 4 }
				const worst = states.reduce(
					(w, st) => {
						const sev = String(st.severity || '').toLowerCase()
						return (rank[sev] ?? 1) > (rank[w] ?? 1) ? sev : w
					},
					states.length ? 'ready' : 'unknown',
				)
				const notifications = (notes.find((n) => n.machine?.name === name)?.notifications || []).map((n) =>
					String(n.summary || n.detail || ''),
				)
				const dropped = Number(m.status?.videoDroppedFrames) || 0
				const prev = this.machines.get(name)
				this.machines.set(name, {
					key: prev?.key || '',
					name,
					hostname: String(m.machine?.hostname || ''),
					uid: String(m.machine?.uid || ''),
					role: roles.get(name) || prev?.role || '',
					fps: Math.round((m.status?.averageFPS || 0) * 10) / 10,
					dropped,
					state: worst,
					problems: problems.map((st) => `${st.name}: ${st.detail}`).join(', '),
					notifications,
				})
			}
			for (const name of [...this.machines.keys()]) if (!seen.has(name)) this.machines.delete(name)
			this.assignMachineKeys()
			this.health.dropped = [...this.machines.values()].reduce((n, m) => n + m.dropped, 0)
			if (previousKeys !== [...this.machines.keys()].join(',')) this.rebuildDefinitions(false)
		} catch (e) {
			this.log('debug', `Health: ${e?.message || e}`)
		}
	}

	assignMachineKeys() {
		const used = new Set()
		for (const m of this.machines.values()) {
			let base = m.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_+|_+$/g, '')
			if (!base) base = 'machine'
			let key = base
			let n = 2
			while (used.has(key)) key = `${base}_${n++}`
			used.add(key)
			m.key = key
		}
	}

	/** Machines for variables and presets. */
	machineTargets() {
		return [...this.machines.values()].map((m) => ({ key: m.key, name: m.name, role: m.role }))
	}

	machineChoices() {
		return [...this.machines.values()].map((m) => ({ id: m.name, label: `${m.name}${m.role ? ` (${m.role})` : ''}` }))
	}

	/** @param {unknown} option machine name or uid */
	resolveMachine(option) {
		const v = String(option ?? '').trim()
		if (!v) return undefined
		const lc = v.toLowerCase()
		const m = [...this.machines.values()].find(
			(m) => m.uid === v || m.name.toLowerCase() === lc || m.hostname.toLowerCase() === lc,
		)
		if (m) return m
		const pair = (this.failover.pairs || []).find((p) => p.target.toLowerCase() === lc || (p.uid && p.uid === v))
		return pair ? { uid: pair.uid, name: pair.target, hostname: pair.target } : undefined
	}

	/** Machines that an understudy can replace (understudy targets), as dropdown choices. */
	failoverTargetChoices() {
		const seen = new Set()
		const out = []
		for (const p of this.failover.pairs || []) {
			if (seen.has(p.target)) continue
			seen.add(p.target)
			out.push({ id: p.target, label: `${p.target} (understudy ${p.understudy})` })
		}
		return out.length ? out : this.machineChoices()
	}

	/**
	 * Alerts of a machine that are newer than the last acknowledge.
	 * @param {{name:string, dropped:number, problems:string, notifications:string[]}} m
	 * @param {boolean} [ignoreAck]
	 */
	machineAlerts(m, ignoreAck = false) {
		const ack = ignoreAck ? undefined : this.machineAck.get(m.name)
		const dropped = Math.max(0, m.dropped - (ack?.dropped || 0))
		const states = m.problems && m.problems !== (ack?.problems || '') ? m.problems.split(', ').filter(Boolean) : []
		const acked = new Set(ack?.notifications || [])
		const notifications = m.notifications.filter((n) => !acked.has(n))
		const text = [...(dropped > 0 ? [`${dropped} dropped frames`] : []), ...states, ...notifications].join(', ')
		return { dropped, states, notifications, text, count: (dropped > 0 ? 1 : 0) + states.length + notifications.length }
	}

	/**
	 * Acknowledges the current alerts of one machine (or all): the indication clears until something new happens.
	 * @param {unknown} option machine name or 'all'
	 */
	acknowledgeMachine(option) {
		const v = String(option ?? 'all').trim()
		const list = v === 'all' || !v ? [...this.machines.values()] : [this.resolveMachine(v)].filter(Boolean)
		if (list.length === 0) {
			this.log('warn', `Acknowledge: machine "${v}" not found`)
			return
		}
		for (const m of list)
			this.machineAck.set(m.name, { dropped: m.dropped, problems: m.problems, notifications: [...m.notifications] })
		this.log('info', `Alerts acknowledged: ${list.map((m) => m.name).join(', ')}`)
		this.publishMachines()
		this.checkFeedbacks('machine_health')
	}

	publishMachines() {
		if (this.destroyed) return
		/** @type {Record<string, unknown>} */
		const values = {}
		for (const m of this.machines.values()) {
			const alerts = this.machineAlerts(m)
			const snap = {
				role: m.role,
				state: m.state,
				problems: m.problems,
				fps: m.fps,
				dropped_frames: m.dropped,
				notifications: m.notifications.length,
				alerts: alerts.text,
				alert_count: alerts.count,
			}
			for (const [id] of MACHINE_VARS) values[`m_${m.key}_${id}`] = snap[id]
		}
		this.setVariableValues(values)
	}

	// ────────────────────────────────────────────────────────────── definitions

	/**
	 * (Re)publishes variable, action, feedback and preset definitions. Needed at start and whenever the
	 * session's transports or tracks change (dropdown choices, per-transport variables and presets).
	 * @param {boolean} initial
	 */
	rebuildDefinitions(initial) {
		if (this.destroyed) return
		this.setVariableDefinitions(getVariableDefinitions(this))
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.publishPresets()
		if (!initial) this.log('debug', `Definitions rebuilt for ${this.transports.size} transport(s)`)
	}

	publishPresets() {
		const { structure, presets } = getPresetDefinitions(this)
		this.setPresetDefinitions(structure, presets)
	}

	/** Owners of a variable set: the active transport, every transport, every multitransport. */
	variableTargets() {
		return [
			{ key: ACTIVE_KEY, label: 'Active transport' },
			...[...this.transports.values()].map((t) => ({ key: t.key, label: `Transport "${t.name}"` })),
			...[...this.multis.values()].map((m) => ({ key: m.key, label: `Multitransport "${m.name}"` })),
		]
	}

	/** Preset groups: id is the value of the transport option. */
	presetTargets() {
		return [
			{ id: 'active', key: ACTIVE_KEY, name: 'Active', kind: 'active' },
			...[...this.multis.values()].map((m) => ({ id: m.uid, key: m.key, name: m.name, kind: 'multi' })),
			...[...this.transports.values()].map((t) => ({ id: t.uid, key: t.key, name: t.name, kind: 'transport' })),
		]
	}

	transportChoices() {
		return [
			{ id: 'active', label: 'Active transport' },
			{ id: 'all', label: 'All transports' },
			...[...this.transports.values()].map((t) => ({ id: t.uid, label: t.name })),
			...[...this.multis.values()].map((m) => ({
				id: m.uid,
				label: `${m.name} (multitransport, ${m.members.length})`,
			})),
		]
	}

	trackChoices() {
		return [...this.tracks.values()].map((t) => ({ id: t.uid, label: t.name }))
	}

	/**
	 * Layer types as Designer names them (module `__username__`, e.g. VariableVideoModule → "Video",
	 * IgnoreTimecodeModule → "Timecode Mode"). Until the Director answers, a default list is offered.
	 */
	layerTypeChoices() {
		const fallback = DisguiseInstance.DEFAULT_LAYER_TYPES.map(([id, name]) => ({ id, name }))
		const list = this.layerTypes.length ? this.layerTypes : fallback
		const preferred = DisguiseInstance.DEFAULT_LAYER_TYPES.map(([id]) => id)
		const first = preferred.map((id) => list.find((t) => t.id === id)).filter(Boolean)
		const rest = list.filter((t) => !preferred.includes(t.id)).sort((a, b) => a.name.localeCompare(b.name))
		return [...first, ...rest].map((t) => ({ id: t.id, label: t.name }))
	}

	/** Designer's display name of a module class (without "Module"). */
	layerTypeName(id) {
		const t =
			this.layerTypes.find((x) => x.id === id) ||
			DisguiseInstance.DEFAULT_LAYER_TYPES.map(([i, n]) => ({ id: i, name: n })).find((x) => x.id === id)
		return t ? t.name : DisguiseInstance.prettyName(id)
	}

	/** "TimecodeMode" → "Timecode Mode", "MTC" stays, "DmxLightsControl" → "Dmx Lights Control". */
	static prettyName(s) {
		return String(s)
			.replace(/Module$/, '')
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
	}

	/**
	 * Resolves the "Transport" option of an action/feedback to real transports.
	 * @param {unknown} option 'active' | 'all' | uid | multitransport uid | name (case-insensitive) | variable key
	 * @returns {TransportState[]}
	 */
	resolveTargets(option) {
		const v = String(option ?? 'active').trim()
		if (!v || v === 'active') {
			const t = this.transports.get(this.activeUid) || [...this.transports.values()][0]
			return t ? [t] : []
		}
		if (v === 'all') return [...this.transports.values()]
		const direct = this.transports.get(v)
		if (direct) return [direct]
		const multi = this.multis.get(v)
		if (multi) return this.membersOf(multi)
		const lc = v.toLowerCase()
		const byName = [...this.transports.values()].find(
			(t) => t.name.toLowerCase() === lc || objectPathName(t.name).toLowerCase() === lc || t.key === lc,
		)
		if (byName) return [byName]
		const multiByName = [...this.multis.values()].find((m) => m.name.toLowerCase() === lc || m.key === lc)
		if (multiByName) return this.membersOf(multiByName)
		const partial = [...this.transports.values()].filter((t) => t.name.toLowerCase().includes(lc))
		return partial.length === 1 ? partial : []
	}

	/** @param {{members:string[]}} multi */
	membersOf(multi) {
		return multi.members.map((uid) => this.transports.get(uid)).filter(Boolean)
	}

	/**
	 * Resolves a track option (uid or name).
	 * @param {unknown} option
	 */
	resolveTrack(option) {
		const v = String(option ?? '').trim()
		if (!v) return undefined
		if (this.tracks.has(v)) return this.tracks.get(v)
		const lc = v.toLowerCase()
		const exact = [...this.tracks.values()].find((t) => t.name.toLowerCase() === lc)
		if (exact) return exact
		const partial = [...this.tracks.values()].filter((t) => t.name.toLowerCase().includes(lc))
		return partial.length === 1 ? partial[0] : undefined
	}

	// ────────────────────────────────────────────────────────────── live update

	/** @param {{tag:string, name:string, values:Record<string, unknown>}} u */
	onLive(u) {
		if (u.tag === 'global') return this.onLiveGlobal(u.values)
		let t = this.findTransportByObjectName(u.name)
		if (!t && typeof u.values.uid === 'string') t = this.transports.get(String(u.values.uid))
		if (!t) return
		const v = u.values
		let stateChanged = false
		let trackChanged = false
		if ('time' in v) t.time = Number(v.time) || 0
		if ('playing' in v && t.playing !== !!v.playing) {
			t.playing = !!v.playing
			stateChanged = true
		}
		if ('state' in v) {
			const mode = STATE_TO_MODE[Number(v.state)]
			if (mode && mode !== t.playmode) {
				t.playmode = mode
				stateChanged = true
			}
		}
		if ('engaged' in v && t.engaged !== !!v.engaged) {
			t.engaged = !!v.engaged
			stateChanged = true
		}
		if ('trackUid' in v) {
			const uid = String(v.trackUid)
			if (uid && uid !== t.trackUid) {
				t.trackUid = uid
				trackChanged = true
			}
		}
		if ('trackName' in v && typeof v.trackName === 'string') {
			t.trackName = v.trackName
			const known = this.tracks.get(t.trackUid)
			if (known && !known.name) known.name = v.trackName
			if (!known && t.trackUid) this.tracks.set(t.trackUid, { uid: t.trackUid, name: v.trackName, length: 0 })
		}
		if ('volume' in v) t.volume = Number(v.volume) || 0
		if ('brightness' in v) t.brightness = Number(v.brightness) || 0
		if ('rate' in v) t.rateClock = tc.clockFromRate(v.rate)
		if ('smpte' in v) t.smpteClock = tc.clockFromSmpteType(v.smpte)
		if ('tcStatus' in v) {
			const s = String(v.tcStatus ?? '')
			if (s !== t.tcStatus) {
				t.tcStatus = s
				stateChanged = true
			}
		}
		if ('tcSource' in v) {
			const s = String(v.tcSource ?? '')
			if (s !== t.tcSource) {
				t.tcSource = s
				stateChanged = true
			}
		}
		if ('tcIncoming' in v) t.tcIncoming = String(v.tcIncoming ?? '')
		if ('tcIncomingSeconds' in v) t.tcIncomingSeconds = Number(v.tcIncomingSeconds)
		if (trackChanged) {
			const known = this.tracks.get(t.trackUid)
			if (known?.name) t.trackName = known.name
			// the cuelist of the new track may be unknown or stale – reload it and republish
			this.guard('annotations reload', () =>
				this.loadAnnotationsFor(t.trackUid).then(() => {
					if (!this.destroyed && this.transports.get(t.uid) === t) this.publishTransport(t, true)
				}),
			)
		}
		this.publishTransport(t, stateChanged || trackChanged)
	}

	/** Director-wide values (master output, fade duration, machine role, layer types, saved layers). */
	onLiveGlobal(v) {
		let changed = false
		if ('masterOutput' in v) {
			const n = Number(v.masterOutput)
			if (n !== this.master.output) {
				this.master.output = n
				changed = true
				this.checkFeedbacks('master_output')
			}
		}
		if ('fadeDuration' in v) this.master.fadeDuration = Math.round(Number(v.fadeDuration) * 100) / 100
		if ('projectName' in v && v.projectName) this.projectName = String(v.projectName)
		if ('thisMachine' in v || 'directorMode' in v || 'directorMachine' in v) {
			const h = this.hostByKey(this.activeHostKey)
			if (h) {
				if ('thisMachine' in v) h.machine = String(v.thisMachine ?? '')
				if ('directorMachine' in v) h.director = String(v.directorMachine ?? '')
				// flags arrive one by one – keep them on the host and derive the role from the stored set
				h.flags = h.flags || {}
				for (const k of ['directorMode', 'editorMode', 'actorMode']) if (k in v) h.flags[k] = !!v[k]
				if ('directorMode' in v || 'editorMode' in v || 'actorMode' in v) {
					h.isDirector = !!h.flags.directorMode
					h.state = roleOf(h.flags)
				}
				h.reachable = true
			}
		}
		if ('lockedToDirector' in v) {
			const locked = !!v.lockedToDirector
			if (locked !== this.editor.locked) {
				this.editor.locked = locked
				this.checkFeedbacks('editor_locked')
			}
		}
		if ('guiTransport' in v) {
			const name = String(v.guiTransport ?? '')
			this.gui.transport = name
			// the Director GUI's current transport is the active transport – switch active_* right away instead of waiting for the poll
			const t = [...this.transports.values()].find((x) => x.name === name)
			if (t && t.uid !== this.activeUid) {
				this.activeUid = t.uid
				this.log('info', `Active transport: ${t.name}`)
				this.publishTransport(t, true)
				this.checkFeedbacks(...STATE_FEEDBACKS, ...POSITION_FEEDBACKS)
			}
		}
		if ('selectedLayers' in v && Array.isArray(v.selectedLayers)) this.gui.selectedLayers = v.selectedLayers.map(String)
		if ('layerTypes' in v && Array.isArray(v.layerTypes)) {
			// [[class without "Module", Designer user name], …]
			const list = v.layerTypes
				.map((x) =>
					Array.isArray(x)
						? { id: String(x[0]), name: DisguiseInstance.prettyName(String(x[1] || x[0])) }
						: { id: String(x).replace(/Module$/, ''), name: DisguiseInstance.prettyName(String(x)) },
				)
				.filter((x) => x.id)
			if (JSON.stringify(list) !== JSON.stringify(this.layerTypes)) {
				this.layerTypes = list
				this.rebuildDefinitions(false)
			}
		}
		if ('mappings' in v && Array.isArray(v.mappings)) {
			const list = v.mappings.map(String)
			if (list.join('\n') !== this.mappings.join('\n')) {
				this.mappings = list
				this.rebuildDefinitions(false)
			}
		}
		if ('noteLists' in v && Array.isArray(v.noteLists)) {
			const list = v.noteLists.map(String)
			if (list.join('\n') !== this.noteLists.join('\n')) {
				this.noteLists = list
				this.rebuildDefinitions(false)
			}
		}
		if ('blendModes' in v && Array.isArray(v.blendModes)) {
			const list = v.blendModes.map(String)
			if (list.join('\n') !== this.blendModes.join('\n')) {
				this.blendModes = list
				this.rebuildDefinitions(false)
			}
		}
		this.publishGlobals()
		if (changed) this.checkFeedbacks('master_output')
	}

	/** @param {string} objectName name part of transportmanager:<name> */
	findTransportByObjectName(objectName) {
		for (const t of this.transports.values()) if (objectPathName(t.name) === objectName) return t
		return undefined
	}

	// ────────────────────────────────────────────────────────────── derived values & variables

	/** @param {TransportState} t @returns {tc.Clock} */
	clockFor(t) {
		return t.smpteClock || t.rateClock || tc.DEFAULT_CLOCK
	}

	/**
	 * Section/cue context of a transport at its current playhead (cheap; used by feedbacks).
	 * @param {TransportState} t
	 */
	derived(t) {
		const cues = this.cuelists.get(t.trackUid) || []
		const track = this.tracks.get(t.trackUid)
		const time = t.time
		const section = cuelist.sectionAt(cues, time)
		const next = cuelist.sectionAfter(cues, time)
		const trackLength = track?.length || 0
		const sectionEnd = next ? next.time : trackLength > time ? trackLength : time
		return {
			cues,
			track,
			section,
			next,
			elapsed: Math.max(0, time - (section ? section.time : 0)),
			remaining: Math.max(0, sectionEnd - time),
			trackRemaining: trackLength > 0 ? Math.max(0, trackLength - time) : Infinity,
			cueCurrent: cuelist.cueAt(cues, time),
			cueNext: cuelist.cueAfter(cues, time),
		}
	}

	/** Designer's timecode status says the transport is locked to incoming timecode. @param {TransportState} t */
	timecodeMatching(t) {
		const st = String(t.tcStatus || '').toLowerCase()
		if (!st || !t.tcSource) return false
		return !/stopped|no matching|no timecode|none|idle/.test(st)
	}

	/**
	 * All variable values of a transport (without prefix).
	 * @param {TransportState} t
	 */
	snapshot(t) {
		const clock = this.clockFor(t)
		const d = this.derived(t)
		const time = t.time
		const tp = tc.splitTime(time, clock)
		const rp = tc.splitTime(d.remaining, clock)
		const cueRemaining = d.cueNext ? Math.max(0, d.cueNext.time - time) : 0
		const tcp = tc.splitTime(t.tcIncomingSeconds >= 0 ? t.tcIncomingSeconds : 0, clock)
		const trackLength = d.track?.length || 0
		let noteCurrent = ''
		let tagCurrent = ''
		for (const c of d.cues) {
			if (c.time > time + cuelist.EPS) break
			if (c.kind === 'note') noteCurrent = c.text
			else if (c.kind === 'tag') tagCurrent = c.text
		}
		const round2 = (n) => Math.round(n * 100) / 100
		return {
			playmode: t.playmode,
			playing: t.playing,
			engaged: t.engaged,
			track: t.trackName,
			time_tc: tc.toTimecode(time, clock),
			time_seconds: round2(time),
			time_hh: tc.pad2(tp.h),
			time_mm: tc.pad2(tp.m),
			time_ss: tc.pad2(tp.s),
			time_ff: tc.pad2(tp.f),
			track_remaining_tc: tc.toTimecode(Math.max(0, trackLength - time), clock),
			section_index: d.section ? d.section.index : '',
			section_label: d.section ? d.section.text : '',
			section_elapsed_tc: tc.toTimecode(d.elapsed, clock),
			section_remaining_tc: tc.toTimecode(d.remaining, clock),
			section_remaining_seconds: round2(d.remaining),
			section_remaining_hh: tc.pad2(rp.h),
			section_remaining_mm: tc.pad2(rp.m),
			section_remaining_ss: tc.pad2(rp.s),
			section_remaining_ff: tc.pad2(rp.f),
			next_section_index: d.next ? d.next.index : '',
			next_section_label: d.next ? d.next.text : '',
			cue_current: d.cueCurrent ? d.cueCurrent.text : '',
			cue_next: d.cueNext ? d.cueNext.text : '',
			cue_next_remaining_tc: d.cueNext ? tc.toTimecode(cueRemaining, clock) : '',
			note_current: noteCurrent,
			tag_current: tagCurrent,
			volume: Math.round(t.volume * 100),
			brightness: Math.round(t.brightness * 100),
			fps: tc.clockLabel(clock),
			tc_status: t.tcStatus,
			tc_source: t.tcSource,
			tc_incoming: t.tcIncoming,
			tc_incoming_hh: tc.pad2(tcp.h),
			tc_incoming_mm: tc.pad2(tcp.m),
			tc_incoming_ss: tc.pad2(tcp.s),
			tc_incoming_ff: tc.pad2(tcp.f),
			tc_match: this.timecodeMatching(t)
				? 'matching'
				: t.tcStatus && t.tcSource
					? t.tcStatus
					: t.tcSource
						? 'no timecode'
						: 'no source',
			// internal (not published)
			_frame:
				Math.floor(time * clock.fps + 1e-6) +
				(t.tcIncomingSeconds >= 0 ? Math.floor(t.tcIncomingSeconds * clock.fps + 1e-6) * 1e9 : 0),
			_posKey: `${t.trackUid}|${d.section ? d.section.index : ''}|${d.cueCurrent ? d.cueCurrent.time : ''}|${d.cueNext ? d.cueNext.time : ''}`,
		}
	}

	/**
	 * Publishes the variables of a transport (and its mirrors) when something visible changed.
	 * @param {TransportState} t
	 * @param {boolean} force publish even if the frame did not change (state change, refresh)
	 */
	publishTransport(t, force) {
		if (this.destroyed) return
		const snap = this.snapshot(t)
		const frame = snap._frame
		const posKey = snap._posKey
		const posChanged = posKey !== t.lastPosKey
		if (!force && frame === t.lastFrame && !posChanged) return
		t.lastFrame = frame
		t.lastPosKey = posKey
		delete snap._frame
		delete snap._posKey

		/** @type {Record<string, unknown>} */
		const values = {}
		const put = (key, obj) => {
			for (const [id] of TRANSPORT_VARS) values[`${key}_${id}`] = obj[id]
		}
		put(t.key, snap)
		if (t.uid === this.activeUid) put(ACTIVE_KEY, snap)
		for (const m of this.multis.values()) {
			if (m.members[0] !== t.uid) continue
			const members = this.membersOf(m)
			put(m.key, { ...snap, engaged: m.engaged, playing: members.some((x) => x.playing) })
		}
		this.setVariableValues(values)

		if (force) this.checkFeedbacks(...STATE_FEEDBACKS)
		if (force || posChanged) this.checkFeedbacks(...POSITION_FEEDBACKS)
		const now = Date.now()
		if (force || now - this.lastTimedCheck >= TIMED_CHECK_MS) {
			this.lastTimedCheck = now
			this.checkFeedbacks(...TIMED_FEEDBACKS)
		}
	}

	publishGlobals() {
		if (this.destroyed) return
		const active = this.transports.get(this.activeUid)
		this.setVariableValues({
			connected: this.session.connected,
			project: this.projectName,
			designer_version: this.session.version,
			session_mode: this.session.mode,
			director: this.hosts.primary.director || this.hosts.backup?.director || this.session.director,
			active_transport: active ? active.name : '',
			active_host: this.activeHost,
			active_machine: this.hostByKey(this.activeHostKey)?.machine || '',
			primary_host: this.hosts.primary.host,
			primary_state: this.hosts.primary.state,
			backup_host: this.hosts.backup?.host || '',
			backup_state: this.hosts.backup ? this.hosts.backup.state : 'not configured',
			editor_host: this.hosts.editor?.host || '',
			editor_state: this.hosts.editor ? this.hosts.editor.state : 'not configured',
			editor_lock:
				!this.editorTarget?.host || this.editorTarget.state === 'director'
					? 'no editor'
					: this.editorLocked
						? 'locked to Director'
						: 'independent',
			selected_layers: this.gui.selectedLayers.join(', '),
			master_output: MASTER_OUTPUT[this.master.output] || '',
			fade_duration: this.master.fadeDuration,
			failover_preset: this.failover.preset,
			dropped_frames: this.health.dropped,
		})
	}

	// ────────────────────────────────────────────────────────────── Director-wide commands (Live Update)

	/**
	 * Evaluates a Python expression once on the Director.
	 * @param {string} expr
	 * @param {string} [objectPath]
	 */
	async pyOnce(expr, objectPath, live) {
		const lu = live || this.live
		if (!lu || !lu.connected) throw new Error(`Live Update not connected (${lu ? lu.host : 'no host'})`)
		const result = await lu.evalOnce(objectPath || this.anyObjectPath(), expr)
		this.log('debug', `python: ${expr} → ${result}`)
		if (/^\{.*errorType/.test(result) || /^Exception|Traceback/.test(result)) throw new Error(result)
		return result
	}

	/**
	 * Master output: fade down (black), fade up, hold.
	 * @param {unknown} mode 'fadedown' | 'fadeup' | 'hold' | 'toggle'
	 */
	async masterFade(mode) {
		let m = String(mode || 'fadedown').toLowerCase()
		if (m === 'toggle') m = this.master.output === 0 ? 'fadeup' : 'fadedown'
		const id = MASTER_OUTPUT_IDS[m]
		if (id === undefined) throw new Error(`unknown master mode "${mode}"`)
		await this.pyOnce(`setattr(${D3}.state.localOrDirectorState(), 'output', ${id})`)
		this.master.output = id
		this.publishGlobals()
		this.checkFeedbacks('master_output')
	}

	/** @param {unknown} seconds */
	async setFadeDuration(seconds) {
		const n = Number(String(seconds ?? '').replace(',', '.'))
		if (!Number.isFinite(n) || n < 0) throw new Error(`"${seconds}" is not a duration`)
		await this.pyOnce(`setattr(${D3}.state, 'fadeDurationSec', ${n})`)
		this.master.fadeDuration = n
		this.publishGlobals()
	}

	/**
	 * Go to timecode (HH:MM:SS:FF) via Designer's gototimecode.
	 * @param {TransportState[]} targets
	 * @param {unknown} text
	 * @param {boolean} ignoreTags
	 * @param {string} playmode
	 */
	async gotoTimecodeText(targets, text, ignoreTags, playmode) {
		const api = this.api
		if (!api || targets.length === 0) return
		const raw = String(text ?? '').trim()
		if (!raw) throw new Error('no timecode given')
		let timecode = raw
		if (!/^\d{1,2}:\d{2}:\d{2}[:;.]\d{1,2}$/.test(raw)) {
			// seconds or partial timecode → normalise through the transport's clock
			const seconds = tc.parseTime(raw, this.clockFor(targets[0]))
			if (seconds === undefined) throw new Error(`"${raw}" is not a timecode`)
			timecode = tc.toTimecode(seconds, this.clockFor(targets[0])).replace(';', ':')
		}
		await api.gotoTimecode(targets, timecode, playmode, ignoreTags)
	}

	// ────────────────────────────────────────────────────────────── layers (Live Update, Python)

	/**
	 * Runs `body` with `l` bound to the layer called `name` on the transport's current track; 'layer not found' otherwise.
	 * @param {string} name
	 * @param {string} body
	 */
	static withLayer(name, body) {
		return `(lambda l: (${body}) if l else 'layer not found')(object.player.track.findLayerByName(${pyStr(name)}))`
	}

	/**
	 * Adds a new layer of the given type at the playhead (or a given time).
	 * @param {TransportState[]} targets
	 * @param {{type:string, name:string, length:unknown, start:unknown, toSectionEnd:boolean}} o
	 */
	async layerAdd(targets, o) {
		const type = String(o.type || '')
			.trim()
			.replace(/Module$/, '')
		if (!type) throw new Error('no layer type')
		const name = String(o.name || type).trim()
		for (const t of targets) {
			const objectPath = this.editObjectPath(t)
			const d = this.derived(t)
			const start =
				o.start !== undefined && String(o.start).trim() !== '' ? tc.parseTime(o.start, this.clockFor(t)) : t.time
			if (start === undefined) throw new Error(`"${o.start}" is not a time`)
			let length = Number(String(o.length ?? '').replace(',', '.'))
			if (o.toSectionEnd) length = Math.max(0.04, d.remaining)
			if (!Number.isFinite(length) || length <= 0) length = 10
			const result = await this.pyOnce(
				`object.player.track.addNewLayer(${D3}.${type}Module, ${Number(start)}, ${Number(length)}, ${pyStr(name)}).name`,
				objectPath,
			)
			this.log(
				'info',
				`Layer "${result}" (${type}) added on ${t.name} at ${start.toFixed(2)} s, length ${length.toFixed(2)} s`,
			)
		}
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {string} name
	 * @param {string} newName
	 */
	async layerDuplicate(targets, name, newName) {
		const n = String(name || '').trim()
		if (!n) throw new Error('no layer name')
		for (const t of targets) {
			const objectPath = this.editObjectPath(t)
			const r = await this.pyOnce(
				DisguiseInstance.withLayer(
					n,
					`object.player.track.duplicateLayer(l, ${pyStr(String(newName || '').trim() || `${n} copy`)}).name`,
				),
				objectPath,
			)
			if (r === 'layer not found') this.log('warn', `Layer "${n}" not found on ${t.name}`)
			else this.log('info', `Layer "${n}" duplicated as "${r}" on ${t.name}`)
		}
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {string} name
	 */
	async layerRemove(targets, name) {
		const n = String(name || '').trim()
		if (!n) throw new Error('no layer name')
		for (const t of targets) {
			const objectPath = this.editObjectPath(t)
			const r = await this.pyOnce(DisguiseInstance.withLayer(n, 'object.player.track.removeLayer(l)'), objectPath)
			if (r === 'layer not found') this.log('warn', `Layer "${n}" not found on ${t.name}`)
			else this.log('info', `Layer "${n}" removed on ${t.name}`)
		}
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {string} name
	 * @param {'on'|'off'|'toggle'} mode
	 */
	async layerEnable(targets, name, mode) {
		const n = String(name || '').trim()
		if (!n) throw new Error('no layer name')
		const value = mode === 'toggle' ? '(not l.enabled)' : mode === 'off' ? 'False' : 'True'
		for (const t of targets) {
			const objectPath = this.editObjectPath(t)
			const r = await this.pyOnce(
				DisguiseInstance.withLayer(n, `setattr(l, 'enabled', ${value}) or l.enabled`),
				objectPath,
			)
			if (r === 'layer not found') this.log('warn', `Layer "${n}" not found on ${t.name}`)
			else this.log('info', `Layer "${n}" on ${t.name}: enabled = ${r}`)
		}
	}

	/**
	 * Moves/resizes a layer: start (time) and length in seconds; empty keeps the current value.
	 * @param {TransportState[]} targets
	 * @param {string} name
	 * @param {unknown} start
	 * @param {unknown} length
	 */
	async layerExtents(targets, name, start, length) {
		const n = String(name || '').trim()
		if (!n) throw new Error('no layer name')
		for (const t of targets) {
			const objectPath = this.editObjectPath(t)
			const s = String(start ?? '').trim() === '' ? undefined : tc.parseTime(start, this.clockFor(t))
			const len = String(length ?? '').trim() === '' ? undefined : Number(String(length).replace(',', '.'))
			const startExpr = s === undefined ? 'l.tStart' : String(s)
			const endExpr = len === undefined ? `(${startExpr}) + l.tLength` : `(${startExpr}) + ${len}`
			const r = await this.pyOnce(
				DisguiseInstance.withLayer(n, `l.setExtents(${startExpr}, ${endExpr}) or (str(l.tStart) + '-' + str(l.tEnd))`),
				objectPath,
			)
			if (r === 'layer not found') this.log('warn', `Layer "${n}" not found on ${t.name}`)
			else this.log('info', `Layer "${n}" on ${t.name} now ${r}`)
		}
	}

	/**
	 * Duplicate / copy / cut / paste the layers selected in the Designer GUI.
	 * Copy remembers the selected layer names; paste duplicates them at the playhead. Cut remembers them and paste
	 * moves them to the playhead (nothing is deleted, so nothing can be lost).
	 * @param {TransportState[]} targets
	 * @param {unknown} op
	 */
	async layerSelection(targets, op) {
		const t = this.editTransport(targets)
		if (!t) return
		const objectPath = this.editObjectPath(t)
		const sel = DisguiseInstance.selectedExpr()
		const o = String(op || 'duplicate')
		if (o === 'copy' || o === 'cut') {
			const names = this.gui.selectedLayers.length
				? this.gui.selectedLayers
				: JSON.parse((await this.pyOnce(`__import__('json').dumps([str(l.name) for l in ${sel}])`, objectPath)) || '[]')
			if (!names.length) {
				this.log('warn', `Layer ${o}: no layer selected in Designer`)
				return
			}
			this.layerClip = { mode: o, names, track: t.trackUid }
			this.log('info', `Layer ${o}: ${names.join(', ')}`)
			return
		}
		if (o === 'paste') {
			const clip = this.layerClip
			if (!clip || !clip.names.length) {
				this.log('warn', 'Paste: nothing copied or cut yet')
				return
			}
			const time = Number(t.time)
			const names = `[${clip.names.map((n) => pyStr(n)).join(', ')}]`
			const expr =
				clip.mode === 'cut'
					? `[l.setExtents(${time}, ${time} + l.tLength) for l in [object.player.track.findLayerByName(n) for n in ${names}] if l] and 'moved'`
					: `[d.setExtents(${time}, ${time} + l.tLength) for (l, d) in [(l, object.player.track.duplicateLayer(l, str(l.name) + ' copy')) for l in [object.player.track.findLayerByName(n) for n in ${names}] if l]] and 'pasted'`
			const r = await this.pyOnce(expr, objectPath)
			this.log('info', `Layer paste (${clip.mode}) at ${time.toFixed(2)} s on ${t.name}: ${r}`)
			if (clip.mode === 'cut') this.layerClip = { ...clip, mode: 'copy' }
			return
		}
		const r = await this.pyOnce(
			`[object.player.track.duplicateLayer(l, str(l.name) + ' copy').name for l in ${sel}]`,
			objectPath,
		)
		if (r === '[]') this.log('warn', 'Layer duplicate: no layer selected in Designer')
		else this.log('info', `Layer duplicate on ${t.name}: ${r}`)
	}

	/** Python: the layers selected in the Designer GUI. */
	static selectedExpr() {
		return `[l for l in list(${D3}.guisystem.selectedLayers) if l]`
	}

	/**
	 * Runs `body` for every selected layer (l bound), returns the list of results.
	 * @param {TransportState} t
	 * @param {string} body
	 */
	async forSelected(t, body) {
		const r = await this.pyOnce(`[(${body}) for l in ${DisguiseInstance.selectedExpr()}]`, this.editObjectPath(t))
		if (r === '[]') this.log('warn', 'No layer selected in Designer')
		return r
	}

	/**
	 * Fits the selected layers to the length of their content: video clips (clipNFrames / clip fps / speed),
	 * else Designer's resourceDuration('video' | 'audio'). Verified on r34 with a 251-frame clip at 25 fps.
	 * @param {TransportState[]} targets
	 */
	async layerFit(targets) {
		const t = this.editTransport(targets)
		if (!t) return
		const fields = '[str(f.name) for f in l.fields]'
		const clip =
			"(float(l.module.clipNFrames) / float(l.module.video.fps) / max(float(getattr(l.module, 'speed', 1.0) or 1.0), 0.01) " +
			"if 'video' in " +
			fields +
			" and getattr(l.module, 'video', None) is not None and float(getattr(l.module, 'clipNFrames', -1)) > 0 and float(getattr(l.module.video, 'fps', 0) or 0) > 0 else 0.0)"
		const res =
			"next((float(l.module.resourceDuration(n)) for n in ['video', 'audio'] if n in " +
			fields +
			' and float(l.module.resourceDuration(n)) > 0), 0.0)'
		const dur = `(${clip} or ${res})`
		const r = await this.forSelected(
			t,
			`(l.setExtents(l.tStart, l.tStart + ${dur}) or (str(l.name) + ': ' + str(round(${dur}, 2)) + ' s, ' + str(l.tStart) + '-' + str(l.tEnd))) if ${dur} > 0 else (str(l.name) + ': no content length')`,
		)
		this.log('info', `Fit to content on ${t.name}: ${r}`)
	}

	/**
	 * Keyframe fade on the selected layers: two keys `seconds` apart, from `from` to `to`, anchored at the layer start,
	 * the layer end or the playhead. Designer only shows and uses keys once the field is switched from static to
	 * sequenced (FieldSequence.disableSequencing = False). Keyframe times are layer-local beats.
	 * @param {TransportState[]} targets
	 * @param {{property?:unknown, anchor?:unknown, from?:unknown, to?:unknown, seconds?:unknown}} o
	 */
	async layerFade(targets, o) {
		const t = this.editTransport(targets)
		if (!t) return
		const prop = propertyOf(o.property)
		const sec = Number(String(o.seconds ?? '1').replace(',', '.'))
		if (!Number.isFinite(sec) || sec <= 0) throw new Error(`"${o.seconds}" is not a duration`)
		const from = Number(String(o.from ?? prop.min).replace(',', '.'))
		const to = Number(String(o.to ?? prop.max).replace(',', '.'))
		if (!Number.isFinite(from) || !Number.isFinite(to))
			throw new Error(`values "${o.from}" / "${o.to}" are not numbers`)
		const anchor = String(o.anchor || 'start')
		const bps = 'object.player.track.bpm / 60.0'
		const fs = `l.findSequence(${pyStr(prop.field)})`
		const seq = `${fs}.sequence`
		// start time of the ramp in layer-local seconds
		const t0 =
			anchor === 'end'
				? `max(0.0, l.tLength - ${sec})`
				: anchor === 'playhead'
					? `max(0.0, ${Number(t.time)} - l.tStart)`
					: '0.0'
		const body =
			`(setattr(${fs}, 'disableSequencing', False) or ${seq}.setFloat((${t0}) * ${bps}, ${from}) or ${seq}.setFloat((${t0} + ${sec}) * ${bps}, ${to}) ` +
			`or (str(l.name) + ': ' + ${pyStr(prop.label)} + ' ' + str(${from}) + ' -> ' + str(${to}) + ' at ' + str(round(${t0}, 2)) + ' s, keys at ' + str([round(x, 2) for x in l.keyTimes()])))`
		const r = await this.forSelected(t, `(${body}) if ${fs} else (str(l.name) + ': no field ' + ${pyStr(prop.field)})`)
		this.log('info', `Keyframe fade (${prop.label}, ${anchor}, ${sec} s) on ${t.name}: ${r}`)
	}

	/**
	 * Removes all keyframes of a property on the selected layers and leaves a static value.
	 * @param {TransportState[]} targets
	 * @param {{property?:unknown, value?:unknown}} o
	 */
	async layerKeysClear(targets, o) {
		const t = this.editTransport(targets)
		if (!t) return
		const prop = propertyOf(o.property)
		const value = Number(String(o.value ?? prop.max).replace(',', '.'))
		if (!Number.isFinite(value)) throw new Error(`"${o.value}" is not a number`)
		const fs = `l.findSequence(${pyStr(prop.field)})`
		const seq = `${fs}.sequence`
		const body = `(${seq}.stripToFirstKey() or setattr(${seq}.key(0), 'v', ${value}) or setattr(${fs}, 'disableSequencing', True) or (str(l.name) + ': ' + ${pyStr(prop.label)} + ' static ' + str(${value})))`
		const r = await this.forSelected(t, `(${body}) if ${fs} else (str(l.name) + ': no field ' + ${pyStr(prop.field)})`)
		this.log('info', `Clear keyframes (${prop.label}) on ${t.name}: ${r}`)
	}

	/**
	 * Assigns a static value to a field of the selected layers – the way Designer stores a non-keyframed value:
	 * one key in the field's sequence and the field switched to static (disableSequencing = True). Option fields
	 * (blendMode, mode, at end point) take the option name or index, float fields a number, 'mapping' a mapping name.
	 * @param {TransportState[]} targets
	 * @param {unknown} field Designer field name
	 * @param {unknown} value
	 */
	async layerAssign(targets, field, value) {
		const t = this.editTransport(targets)
		if (!t) return
		const name = String(field ?? '').trim()
		const want = String(value ?? '').trim()
		if (!name) throw new Error('no field given')
		if (!want) throw new Error(`no value for ${name}`)
		const fs = `l.findSequence(${pyStr(name)})`
		const seq = `${fs}.sequence`
		let setExpr
		let readExpr
		if (name === 'mapping') {
			const lc = want.toLowerCase()
			const mapName =
				this.mappings.find((m) => m.toLowerCase() === lc) ||
				this.mappings.find((m) => m.toLowerCase().replace(/ \(direct\)$/, '') === lc) ||
				this.mappings.find((m) => m.toLowerCase().includes(lc)) ||
				want
			const find = `[p for p in ${D3}.resourceManager.allResources(${D3}.Projection) if str(p.description) == ${pyStr(mapName)}]`
			setExpr = `(${seq}.setResource(0.0, ${find}[0]) if len(${find}) else (_ for _ in ()).throw(Exception('mapping not found: ' + ${pyStr(mapName)})))`
			readExpr = `str(${seq}.evalResource(0.0).description)`
		} else {
			// option fields: resolve the option name to its index via Designer's option list
			const opts = `[str(o) for o in ${fs}.options()]`
			const isNumber = /^[+-]?\d+(\.\d+)?$/.test(want)
			const valueExpr = isNumber ? String(Number(want)) : `float(${opts}.index(${pyStr(want)}))`
			setExpr = `(setattr(${seq}.key(0), 'v', ${valueExpr}) if (${isNumber ? 'True' : `${pyStr(want)} in ${opts}`}) else (_ for _ in ()).throw(Exception('option not found: ' + ${pyStr(want)} + ' in ' + str(${opts}))))`
			readExpr = `(${opts}[int(${seq}.key(0).v)] if len(${opts}) else str(${seq}.key(0).v))`
		}
		const body = `(${seq}.stripToFirstKey() or ${setExpr} or setattr(${fs}, 'disableSequencing', True) or (str(l.name) + ': ' + ${pyStr(name)} + ' = ' + ${readExpr}))`
		const r = await this.forSelected(t, `(${body}) if ${fs} else (str(l.name) + ': no field ' + ${pyStr(name)})`)
		this.log('info', `Assign ${name} on ${t.name}: ${r}`)
	}

	/** @param {TransportState[]} targets @param {unknown} mode blend mode name or index */
	layerBlendMode(targets, mode) {
		return this.layerAssign(targets, 'blendMode', mode)
	}

	/** @param {TransportState[]} targets @param {unknown} mapping mapping name */
	layerMapping(targets, mapping) {
		return this.layerAssign(targets, 'mapping', mapping)
	}

	/**
	 * Evaluates an expression once on another configured host (short-lived Live Update connection).
	 * @param {string} host
	 * @param {string} expr
	 * @param {string} objectPath
	 */
	pyOnceOnHost(host, expr, objectPath) {
		return new Promise((resolve, reject) => {
			const lu = new LiveUpdate({ host, port: Number(this.config.port) || 80 })
			let done = false
			const finish = (err, val) => {
				if (done) return
				done = true
				clearTimeout(timer)
				lu.stop()
				if (err) reject(err)
				else resolve(val)
			}
			const timer = setTimeout(() => finish(new Error(`${host}: timeout`)), 6000)
			lu.on('open', () =>
				lu.evalOnce(objectPath, expr).then(
					(v) => finish(undefined, v),
					(e) => finish(e),
				),
			)
			lu.on('close', () => finish(new Error(`${host}: websocket closed`)))
			lu.on('error', () => {})
			lu.start()
		})
	}

	/**
	 * Appends a paragraph to a Designer note: a global note list (Note resource in objects/note) or the note of a
	 * track (internal/note/track/<track>.apx, created if missing). Written on the machine the commands go to
	 * (Designer keeps notes per machine).
	 * @param {{target?:unknown, text?:unknown, parts?:unknown}} o target: 'track' (track shown in the GUI),
	 *   'track:<uid or name>' or the name of a note list; parts: prefix parts in order (datetime, time, timecode,
	 *   transport, track, section)
	 */
	async noteAppend(o) {
		const ctx = this.editContext()
		const objectPath = ctx ? ctx.objectPath : this.anyObjectPath()
		const text = String(o.text ?? '').trim()
		if (!text) throw new Error('no text given')
		const target = String(o.target ?? 'track').trim()
		const parts = Array.isArray(o.parts) ? o.parts.map(String) : []
		const now = new Date()
		const d = ctx ? this.derived(ctx.t) : undefined
		const values = {
			datetime: now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }),
			time: now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
			timecode: ctx ? tc.toTimecode(ctx.t.time, this.clockFor(ctx.t)) : '',
			transport: ctx ? ctx.t.name : '',
			track: ctx ? ctx.t.trackName : '',
			section: d?.section ? d.section.text : '',
		}
		const order = ['datetime', 'time', 'timecode', 'transport', 'track', 'section']
		const prefix = order
			.filter((k) => parts.includes(k) && values[k])
			.map((k) => values[k])
			.join(' | ')
		const line = pyStr(prefix ? `${prefix} | ${text}` : text)
		// target: the track shown in the GUI (resolved to its name so every host writes the same note), a specific track or a note list
		let trackName
		if (target === 'track') trackName = ctx?.t.trackName || ''
		else if (target.startsWith('track:')) {
			const ref = target.slice(6).trim()
			const tr = this.resolveTrack(ref)
			if (!tr) throw new Error(`track "${ref}" not found`)
			trackName = tr.name
		}
		if (target === 'track' && !trackName) throw new Error('current track unknown')
		const note = trackName
			? `${D3}.resourceManager.load(${D3}.Path('internal/note/track/' + ${pyStr(trackName)} + '.apx'), ${D3}.Note)`
			: `[n for n in ${D3}.resourceManager.allResources(${D3}.Note) if str(n.description) == ${pyStr(target)}][0]`
		const guard = trackName
			? 'True'
			: `len([n for n in ${D3}.resourceManager.allResources(${D3}.Note) if str(n.description) == ${pyStr(target)}])`
		const expr = `(lambda n: (setattr(n, 'text', (n.text + '\\n' if n.text else '') + ${line}) or n.save() or (str(n.description) + ': ' + str(len(n.text.split('\\n'))) + ' lines')))(${note}) if ${guard} else 'note list not found'`
		const label = trackName ? `track note "${trackName}"` : `note list "${target}"`
		const r = await this.pyOnce(expr, objectPath)
		if (r === 'note list not found') throw new Error(`${label} not found`)
		this.log(
			'info',
			`Note appended to ${label} on ${this.activeHost}: "${prefix ? `${prefix} | ${text}` : text}" → ${r}`,
		)
	}

	/**
	 * Adds a tag (CUE / MIDI / TC) or a note at the playhead of the GUI transport's track.
	 * Designer: Track.setTagAtBeat(beat, d3.Tag(type, text)), Track.setNoteAtBeat(beat, text); Tag.TC=0, CUE=1, MIDI=2.
	 * @param {TransportState[]} targets
	 * @param {{kind?:unknown, text?:unknown}} o
	 */
	async addAnnotation(targets, o) {
		const t = this.editTransport(targets)
		if (!t) return
		const objectPath = this.editObjectPath(t)
		const kind = String(o.kind || 'cue').toLowerCase()
		const text = String(o.text ?? '').trim()
		if (!text) throw new Error('no text given')
		const beat = `(${Number(t.time)} * object.player.track.bpm / 60.0)`
		const tagType = { cue: 'CUE', midi: 'MIDI', tc: 'TC' }[kind]
		const expr =
			kind === 'note'
				? `object.player.track.setNoteAtBeat(${beat}, ${pyStr(text)}) or 'note'`
				: `object.player.track.setTagAtBeat(${beat}, ${D3}.Tag(${D3}.Tag.${tagType || 'CUE'}, ${pyStr(text)})) or ${pyStr(tagType || 'CUE')}`
		const r = await this.pyOnce(expr, objectPath)
		this.log('info', `Added ${r} "${text}" at ${t.time.toFixed(2)} s on ${t.name}`)
		await this.loadAnnotationsFor(t.trackUid)
		this.publishTransport(t, true)
	}

	/**
	 * Crossfade of the section the playhead is in: "undefined" (mode 0) or "fade" with a duration and the loop
	 * crossfade flag. Designer keeps the transition on the section's Cue object (Track.cues, Cue.sectionTransition);
	 * the cue is found by the section start time. Note: Track.transitionInfoAtSection(i) and the REST annotations
	 * index the cue table instead of the section list, so their read-back is shifted when tags/notes precede.
	 * @param {TransportState[]} targets
	 * @param {{mode?:unknown, seconds?:unknown, loop?:unknown}} o
	 */
	async sectionCrossfade(targets, o) {
		const t = this.editTransport(targets)
		if (!t) return
		const objectPath = this.editObjectPath(t)
		const sec = cuelist.sectionAt(this.cuelists.get(t.trackUid) || [], Number(t.time))
		if (!sec) throw new Error('no section at the playhead')
		const fade = String(o.mode || 'fade').toLowerCase() === 'fade'
		const seconds = Number(String(o.seconds ?? '1').replace(',', '.'))
		if (fade && (!Number.isFinite(seconds) || seconds < 0)) throw new Error(`"${o.seconds}" is not a duration`)
		const loop = fade && !!o.loop
		const bps = 'object.player.track.bpm / 60.0'
		const cues = 'object.player.track.cues'
		const cue = `[${cues}.getV(j) for j in range(${cues}.n()) if ${cues}.getV(j).isSection() and abs(${cues}.getT(j) - ${sec.time} * ${bps}) < 0.002]`
		const expr =
			`(lambda c: (setattr(c.sectionTransition, 'mode', ${fade ? 1 : 0}) or setattr(c.sectionTransition, 'fadeDurationBeats', ${fade ? seconds : 0} * ${bps}) ` +
			`or setattr(c.sectionTransition, 'loopUxFade', ${loop ? 'True' : 'False'}) or ('mode ' + str(c.sectionTransition.mode) + ' fade ' + str(c.sectionTransition.fadeDurationBeats) + ' loop ' + str(c.sectionTransition.loopUxFade))))(${cue}[0]) if len(${cue}) else 'section cue not found'`
		const r = await this.pyOnce(expr, objectPath)
		if (r === 'section cue not found') throw new Error(`no cue for the section at ${sec.time.toFixed(2)} s`)
		this.log(
			'info',
			`Crossfade of section ${sec.index} (${sec.time.toFixed(2)} s) on ${t.name}: ${fade ? `fade ${seconds} s${loop ? ', loop crossfade' : ''}` : 'undefined'} (${r})`,
		)
		await this.loadAnnotationsFor(t.trackUid)
		this.publishTransport(t, true)
	}

	/**
	 * Inserts (or removes) time at the playhead of the GUI transport's track. Designer: Track.insertBeats /
	 * removeBeats(beat, beats, layerMode) with layerMode DontTouchLayers=0, MoveLayers=1, StretchLayers=2.
	 * @param {TransportState[]} targets
	 * @param {{seconds?:unknown, layers?:unknown, remove?:unknown}} o
	 */
	async insertTime(targets, o) {
		const t = this.editTransport(targets)
		if (!t) return
		const objectPath = this.editObjectPath(t)
		const seconds = Number(String(o.seconds ?? '5').replace(',', '.'))
		if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`"${o.seconds}" is not a duration`)
		const mode =
			{ none: 'DontTouchLayers', move: 'MoveLayers', stretch: 'StretchLayers' }[String(o.layers || 'move')] ||
			'MoveLayers'
		const bps = 'object.player.track.bpm / 60.0'
		const fn = o.remove ? 'removeBeats' : 'insertBeats'
		const r = await this.pyOnce(
			`object.player.track.${fn}(${Number(t.time)} * ${bps}, ${seconds} * ${bps}, object.player.track.${mode}) or str(round(object.player.track.lengthInSec, 2))`,
			objectPath,
		)
		this.log(
			'info',
			`${o.remove ? 'Removed' : 'Inserted'} ${seconds} s at ${t.time.toFixed(2)} s on ${t.name} (layers: ${mode}); track length now ${r} s`,
		)
		await this.refreshSession(false)
	}

	/**
	 * Splits or merges the section at the playhead of the active transport.
	 * @param {TransportState[]} targets
	 * @param {unknown} op 'split' | 'merge'
	 */
	async sectionSplit(targets, op) {
		const t = this.editTransport(targets)
		if (!t) return
		const objectPath = this.editObjectPath(t)
		// split: new boundary at the playhead. merge: remove the boundary the playhead is in (start of the current
		// section), like Designer's own merge; a playhead exactly on a boundary removes that one.
		let time = Number(t.time)
		if (String(op) === 'merge') {
			const sec = cuelist.sectionAt(this.cuelists.get(t.trackUid) || [], time)
			if (!sec) throw new Error('no section at the playhead')
			if (sec.time <= 0.0005) throw new Error('the first section has no boundary to merge')
			time = sec.time
		}
		const beat = `(${time} * object.player.track.bpm / 60.0)`
		const expr =
			String(op) === 'merge'
				? `object.player.track.mergeSectionAtBeat(${beat})`
				: `object.player.track.splitSectionAtBeat(${beat}, object.player.track.defaultTransitionInfo)`
		await this.pyOnce(expr, objectPath)
		this.log('info', `Section ${op} at ${time.toFixed(2)} s on ${t.name}`)
		await this.loadAnnotationsFor(t.trackUid)
		this.publishTransport(t, true)
	}

	/** The configured editor host record, or the active host when no editor is configured. */
	get editorTarget() {
		return this.hosts.editor?.host ? this.hosts.editor : this.hostByKey(this.activeHostKey)
	}

	/** Lock state of the editor (from the role probe or, when the editor is the active host, from Live Update). */
	get editorLocked() {
		const h = this.editorTarget
		if (!h) return false
		if (h === this.hostByKey(this.activeHostKey)) return this.editor.locked
		return !!h.locked
	}

	/**
	 * Editor: lock to Director (d3.state.lockedToDirector = True) or independent playback (False). Always addresses
	 * the configured editor, no matter where the other commands go; without an editor the active host.
	 * Verified on a mobile editor (r34).
	 * @param {unknown} mode 'lock' | 'independent' | 'toggle'
	 */
	async editorMode(mode) {
		const target = this.editorTarget
		if (!target?.host) throw new Error('no editor configured')
		const m = String(mode || 'toggle')
		const value = m === 'lock' ? 'True' : m === 'independent' ? 'False' : `(not ${D3}.state.lockedToDirector)`
		const expr = `setattr(${D3}.state, 'lockedToDirector', ${value}) or bool(${D3}.state.lockedToDirector)`
		const onActive = target === this.hostByKey(this.activeHostKey)
		const r = onActive ? await this.pyOnce(expr) : await this.pyOnceOnHost(target.host, expr, this.anyObjectPath())
		const locked = r === 'True'
		if (onActive) this.editor.locked = locked
		target.locked = locked
		this.log(
			'info',
			`${target.host} (${target.machine || 'editor'}): ${locked ? 'locked to Director' : 'independent playback'}`,
		)
		this.publishGlobals()
		this.checkFeedbacks('editor_locked')
	}

	// ────────────────────────────────────────────────────────────── failover commands (REST)

	/**
	 * Replace/restore goes to EVERY configured host (Director, backup, editor), not only the active one: when
	 * the Director is gone the request must still reach the understudy directly. Succeeds when at least one
	 * host accepts; every host's answer is logged.
	 * @param {unknown} machineOption @param {'failover'|'restore'} what
	 */
	async failoverMachine(machineOption, what) {
		const m = this.resolveMachine(machineOption)
		if (!m) throw new Error(`machine "${machineOption}" not found`)
		const port = Number(this.config.port) || 80
		const hosts = ['primary', 'backup', 'editor']
			.map((key) => ({ key, h: this.hostByKey(key) }))
			.filter((x, i, all) => x.h?.host && all.findIndex((y) => y.h?.host === x.h.host) === i)
		if (!hosts.length) throw new Error('no host configured')
		const verb = what === 'restore' ? 'restore' : 'replace'
		const results = await Promise.all(
			hosts.map(async ({ key, h }) => {
				const api = new DisguiseApi({ host: h.host, port, timeoutMs: REQUEST_TIMEOUT_MS })
				try {
					if (what === 'restore') await api.restoreMachine({ uid: m.uid, name: m.name })
					else await api.failoverMachine({ uid: m.uid, name: m.name })
					this.log('warn', `Failover ${verb} ${m.name}: accepted by ${h.machine || key} (${h.host})`)
					return { ok: true, key, host: h.host }
				} catch (e) {
					const msg = e?.message || String(e)
					this.log('warn', `Failover ${verb} ${m.name}: ${h.machine || key} (${h.host}) refused – ${msg}`)
					return { ok: false, key, host: h.host, msg }
				}
			}),
		)
		if (this.failoverTimer) clearTimeout(this.failoverTimer)
		this.failoverTimer = setTimeout(() => this.guard('failover refresh', () => this.refreshSession(true)), 1500)
		if (results.some((r) => r.ok)) return
		// REST refuses a machine that has already left the session ("This machine has already left the session").
		// Designer's own replace/restore buttons still work then: d3.state.cmdMachineFailed/cmdMachineRestored(hostname),
		// tried on the backup first (it is the one that has to take over), then editor, then Director.
		const order = ['backup', 'editor', 'primary'].filter((k) => hosts.some((x) => x.key === k))
		const errors = results.map((r) => `${r.host}: ${r.msg}`)
		for (const key of order) {
			const h = this.hostByKey(key)
			try {
				await this.failoverInternal(h, m.name, what)
				this.log(
					'warn',
					`Failover ${verb} ${m.name}: done through Designer's internal command on ${h.machine || key} (${h.host})`,
				)
				return
			} catch (e) {
				errors.push(`${h.host} (internal): ${e?.message || e}`)
			}
		}
		throw new Error(`no host accepted the ${verb}: ${errors.join('; ')}`)
	}

	/**
	 * Designer's internal replace/restore (what the d3Net manager buttons do) on one host. Verified on r34 with the
	 * Director running: cmdMachineFailed('MACHINE') on the understudy marks MACHINE failed and the understudy runs
	 * as MACHINE in Director mode; cmdMachineRestored brings both back.
	 * @param {{host:string}} h @param {string} machineName @param {'failover'|'restore'} what
	 */
	async failoverInternal(h, machineName, what) {
		const fn = what === 'restore' ? 'cmdMachineRestored' : 'cmdMachineFailed'
		const n = String(machineName).toLowerCase()
		const expr =
			`(lambda n: str(${D3}.state.${fn}([str(m.hostname) for m in ${D3}.d3NetManager.machines ` +
			`if str(m.hostname).lower() == n or str(m.name).lower() == n][0])))(${pyStr(n)})`
		const onActive = h.host === this.activeHost && this.live?.connected
		const r = onActive ? await this.pyOnce(expr) : await this.pyOnceOnHost(h.host, expr, this.anyObjectPath())
		if (/^\{.*errorType/.test(r) || /^Exception|Traceback|IndexError/.test(r)) throw new Error(r)
		return r
	}

	// ────────────────────────────────────────────────────────────── command helpers (used by actions)

	/**
	 * Jumps to the start of the section `delta` sections away from the current one (per transport).
	 * Falls back to Designer's own next/previous section when the track's cuelist is unknown.
	 * @param {TransportState[]} targets
	 * @param {number} delta
	 * @param {string} playmode
	 */
	async jumpSections(targets, delta, playmode) {
		const api = this.api
		if (!api) return
		/** @type {Map<string, TransportState[]>} section index → transports */
		const bySection = new Map()
		const fallback = []
		for (const t of targets) {
			const cues = this.cuelists.get(t.trackUid) || []
			const target = cuelist.sectionByOffset(cues, t.time, delta)
			if (target) {
				const list = bySection.get(target.index) || []
				list.push(t)
				bySection.set(target.index, list)
			} else fallback.push(t)
		}
		const jobs = []
		for (const [index, list] of bySection) {
			this.log('debug', `Jump ${delta}: ${list.map((t) => t.name).join(', ')} → section ${index}`)
			jobs.push(api.gotoSection(list, index, playmode))
		}
		if (fallback.length) {
			this.log(
				'warn',
				`Jump sections: no cuelist for ${fallback.map((t) => `${t.name} (${t.trackName || 'no track'})`).join(', ')} – using Designer's next/previous section`,
			)
			const steps = Math.abs(delta)
			jobs.push(
				(async () => {
					for (let i = 0; i < steps; i++) {
						if (delta < 0) await api.gotoPrevSection(fallback, playmode)
						else await api.gotoNextSection(fallback, playmode)
					}
				})(),
			)
		}
		await Promise.all(jobs)
	}

	/**
	 * Go to a section by index or name.
	 * @param {TransportState[]} targets
	 * @param {unknown} text
	 * @param {string} playmode
	 */
	async gotoSectionText(targets, text, playmode) {
		const api = this.api
		if (!api) return
		const want = String(text ?? '').trim()
		if (!want) throw new Error('no section given')
		const jobs = []
		for (const t of targets) {
			const cues = this.cuelists.get(t.trackUid) || []
			const found = cuelist.findCue(cues, want, { kind: 'section', match: 'exact' })
			if (found) jobs.push(api.gotoSection([t], found.index, playmode))
			else if (/^\d+$/.test(want)) jobs.push(api.gotoSection([t], want, playmode))
			else this.log('warn', `Go to section: "${want}" not found on ${t.name} (${t.trackName || 'no track'})`)
		}
		await Promise.all(jobs)
	}

	/**
	 * Go to a cue/note/section by text; optionally across tracks.
	 * @param {TransportState[]} targets
	 * @param {unknown} text
	 * @param {{kind?:string, match?:string, otherTracks?:boolean}} opts
	 * @param {string} playmode
	 */
	async gotoCue(targets, text, opts, playmode) {
		const api = this.api
		if (!api) return
		const want = String(text ?? '').trim()
		if (!want) throw new Error('no cue text given')
		const search = { kind: /** @type {any} */ (opts.kind || 'auto'), match: /** @type {any} */ (opts.match || 'exact') }
		const jobs = []
		for (const t of targets) {
			const cues = this.cuelists.get(t.trackUid) || []
			const local = cuelist.findCue(cues, want, search)
			if (local) {
				this.log('debug', `Go to cue "${want}" on ${t.name}: ${local.kind} "${local.text}" at ${local.time}s`)
				jobs.push(api.gotoTime([t], local.time, playmode))
				continue
			}
			let other
			if (opts.otherTracks) {
				for (const [trackUid, list] of this.cuelists) {
					if (trackUid === t.trackUid) continue
					const hit = cuelist.findCue(list, want, search)
					if (hit) {
						other = { trackUid, hit }
						break
					}
				}
			}
			if (other) {
				const track = this.tracks.get(other.trackUid) || { uid: other.trackUid, name: '' }
				this.log(
					'info',
					`Go to cue "${want}" on ${t.name}: found on track "${track.name}" (${other.hit.kind} at ${other.hit.time}s)`,
				)
				jobs.push(
					(async () => {
						await api.gotoTrack([t], track, 'Stop')
						await api.gotoTime([t], other.hit.time, playmode)
					})(),
				)
				continue
			}
			// Nothing in the cached cuelists: let Designer search (tags across tracks, then note text).
			this.log('warn', `Go to cue "${want}" on ${t.name}: not in the cached cues – asking Designer directly`)
			jobs.push(
				(async () => {
					try {
						const tagType = search.kind.startsWith('tag:') ? search.kind.slice(4).toUpperCase() : 'CUE'
						await api.gotoTag([t], tagType, want, playmode, !!opts.otherTracks)
					} catch (e) {
						this.log('debug', `gototag CUE "${want}": ${e?.message || e}`)
						await api.gotoNote([t], want, playmode)
					}
				})(),
			)
		}
		await Promise.all(jobs)
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {unknown} text seconds or timecode
	 * @param {string} playmode
	 */
	async gotoTimeText(targets, text, playmode) {
		const api = this.api
		if (!api || targets.length === 0) return
		const seconds = tc.parseTime(text, this.clockFor(targets[0]))
		if (seconds === undefined) throw new Error(`"${text}" is not a time`)
		await api.gotoTime(targets, seconds, playmode)
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {unknown} option track uid or name
	 * @param {string} playmode
	 */
	async gotoTrackOption(targets, option, playmode) {
		const api = this.api
		if (!api) return
		const track = this.resolveTrack(option)
		if (!track) throw new Error(`track "${option}" not found`)
		await api.gotoTrack(targets, track, playmode)
	}

	/**
	 * @param {TransportState[]} targets
	 * @param {unknown} mode 'on' | 'off' | 'toggle'
	 */
	async setEngaged(targets, mode) {
		const api = this.api
		if (!api) return
		const m = String(mode || 'toggle')
		const on = targets.filter((t) => (m === 'toggle' ? !t.engaged : m === 'on'))
		const off = targets.filter((t) => (m === 'toggle' ? t.engaged : m === 'off'))
		await Promise.all([on.length ? api.setEngaged(on, true) : null, off.length ? api.setEngaged(off, false) : null])
		for (const t of on) t.engaged = true
		for (const t of off) t.engaged = false
		for (const t of targets) this.publishTransport(t, true)
	}

	/**
	 * Volume or brightness in percent, absolute or relative to the current value.
	 * @param {TransportState[]} targets
	 * @param {'volume'|'brightness'} kind
	 * @param {unknown} value percent
	 * @param {boolean} relative
	 */
	async setLevel(targets, kind, value, relative) {
		const api = this.api
		if (!api) return
		const pct = Number(String(value ?? '').replace(',', '.'))
		if (!Number.isFinite(pct)) throw new Error(`"${value}" is not a number`)
		/** @type {Map<number, TransportState[]>} */
		const byLevel = new Map()
		for (const t of targets) {
			const cur = kind === 'volume' ? t.volume : t.brightness
			const next = Math.max(0, Math.min(1, relative ? cur + pct / 100 : pct / 100))
			const rounded = Math.round(next * 1000) / 1000
			const list = byLevel.get(rounded) || []
			list.push(t)
			byLevel.set(rounded, list)
		}
		await Promise.all(
			[...byLevel].map(([level, list]) =>
				kind === 'volume' ? api.setVolume(list, level) : api.setBrightness(list, level),
			),
		)
		for (const [level, list] of byLevel) {
			for (const t of list) {
				if (kind === 'volume') t.volume = level
				else t.brightness = level
				this.publishTransport(t, true)
			}
		}
	}
}

module.exports = { DisguiseInstance, ACTIVE_KEY }
