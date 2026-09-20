/**
 * @file REST client for the disguise session API (http://<director>/api/session/…).
 *
 * Verified against Designer r34.0.3: all endpoints answer `{status:{code,message,details}, …}`;
 * a non-zero code is an error. There is no authentication. Transport commands take a list of
 * transports, so one request can address several transports (used for multitransports and "all").
 *
 * Play modes accepted by the goto* endpoints (APIPlayMode): Play, PlaySection, Loop, Stop, NotSet.
 * (LoopSection is rejected with code 4000 – looping is started with playloopsection.)
 */

/** @typedef {{uid:string, name:string}} Ref */
/** @typedef {'Play'|'PlaySection'|'Loop'|'Stop'|'NotSet'} PlayMode */

const PLAY_MODES = ['NotSet', 'Play', 'PlaySection', 'Loop', 'Stop']

class DisguiseApi {
	/**
	 * @param {{host:string, port?:number, timeoutMs?:number, log?:(level:string, msg:string)=>void}} opts
	 */
	constructor(opts) {
		this.host = String(opts.host || '').trim()
		this.port = Number(opts.port) || 80
		this.timeoutMs = Number(opts.timeoutMs) || 4000
		this.log = opts.log || (() => {})
	}

	get base() {
		const hostPort = this.port === 80 ? this.host : `${this.host}:${this.port}`
		return `http://${hostPort}/api/session`
	}

	/**
	 * @param {string} path
	 * @param {RequestInit} [init]
	 * @returns {Promise<any>}
	 */
	async request(path, init) {
		const url = this.base + path
		const fail = (e) => {
			const reason =
				e?.name === 'TimeoutError' || e?.name === 'AbortError'
					? `timeout after ${this.timeoutMs} ms`
					: e?.cause?.code || e?.message || String(e)
			return new Error(`${init?.method || 'GET'} ${path}: ${reason}`, { cause: e })
		}
		let res
		try {
			res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
		} catch (e) {
			throw fail(e)
		}
		if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path}: HTTP ${res.status}`)
		let json
		try {
			// the body of a large response can stall after the headers arrived (see describeFailure in instance.js)
			json = await res.json()
		} catch (e) {
			throw fail(e)
		}
		if (json?.status && json.status.code !== 0) {
			const details =
				Array.isArray(json.status.details) && json.status.details.length
					? ` (${json.status.details
							.map((d) => (d && typeof d === 'object' ? [d.uid, d.message].filter(Boolean).join(': ') : String(d)))
							.join('; ')})`
					: ''
			throw new Error(`${path}: ${json.status.message || 'error'} [code ${json.status.code}]${details}`)
		}
		return json
	}

	get(path) {
		return this.request(path)
	}

	post(path, body) {
		return this.request(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
	}

	// ─────────────────────────────────────────────── status

	/** @returns {Promise<{projectPath:string, version:{major:number,minor:number,hotfix:number,revision?:number,releaseType?:string}}>} */
	async getProject() {
		return (await this.get('/status/project')).result
	}

	/** @returns {Promise<{isRunningSolo:boolean, isDirectorDedicated?:boolean, director?:{uid:string,name:string,hostname:string,type:string}, actors:any[], understudies:any[]}>} */
	async getSession() {
		return (await this.get('/status/session')).result
	}

	/** @returns {Promise<{machine:{uid:string,name:string,hostname:string}, status:{averageFPS:number, videoDroppedFrames:number, videoMissedFrames?:number, states?:any[]}}[]>} */
	async getHealth() {
		return (await this.get('/status/health')).result
	}

	/** @returns {Promise<{machine:{uid:string,name:string,hostname:string}, notifications:{summary:string, detail:string}[]}[]>} */
	async getNotifications() {
		return (await this.get('/status/notifications')).result || []
	}

	// ─────────────────────────────────────────────── failover (session)

	/** @returns {Promise<{timeout:number, normalPreset:string, currentPreset:string}>} */
	async getFailoverSettings() {
		const r = await this.get('/failover/settings')
		return {
			timeout: Number(r.timeout) || 0,
			normalPreset: String(r.normalPreset ?? ''),
			currentPreset: String(r.currentPreset ?? ''),
		}
	}

	/** @returns {Promise<Record<string, {targets:any[]}>>} keyed by understudy hostname */
	async getUnderstudyTargets() {
		return (await this.get('/failover/understudytargets')).understudies || {}
	}

	/** Fails over one actor machine to its understudy. @param {Ref} machine */
	failoverMachine(machine) {
		return this.post('/failover/failovermachine', { machine: DisguiseApi.ref(machine) })
	}

	/** Restores a previously failed-over actor machine. @param {Ref} machine */
	restoreMachine(machine) {
		return this.post('/failover/restoremachine', { machine: DisguiseApi.ref(machine) })
	}

	/** Restores the default matrix feed routing. */
	applyDefaultRouting() {
		return this.post('/failover/applydefaultrouting', {})
	}

	// ─────────────────────────────────────────────── transport queries

	/**
	 * @returns {Promise<{transports:any[], multitransports:{uid:string,name:string,engaged?:boolean,transports:string[]}[]}>}
	 */
	async getTransports() {
		const r = await this.get('/transport/transports')
		const multitransports = (r.multitransports || []).map((m) => ({
			...m,
			// r34 returns member uids as plain strings; older builds may return {uid,name}.
			transports: (m.transports || []).map((x) => (typeof x === 'string' ? x : String(x?.uid ?? ''))),
		}))
		return { transports: r.transports || [], multitransports }
	}

	/**
	 * Designer's "active" transports. Verified on r34: the list can contain several transports (5 of 6 in one
	 * project), so only a single entry is meaningful as "the" active transport.
	 * @returns {Promise<any|undefined>}
	 */
	async getActiveTransport() {
		const r = await this.get('/transport/activetransport')
		return Array.isArray(r.result) && r.result.length === 1 ? r.result[0] : undefined
	}

	/** @returns {Promise<{uid:string,name:string,length:number,crossfade?:string}[]>} */
	async getTracks() {
		return (await this.get('/transport/tracks')).result || []
	}

	/** @returns {Promise<{uid:string,name:string,tracks:{uid:string,name:string,length:number}[]}[]>} */
	async getSetlists() {
		return (await this.get('/transport/setlists')).result || []
	}

	/**
	 * @param {Ref} track
	 * @returns {Promise<{notes:any[], tags:any[], sections:any[]}>}
	 */
	async getAnnotations(track) {
		const q = track.uid ? `uid=${encodeURIComponent(track.uid)}` : `name=${encodeURIComponent(track.name)}`
		const r = await this.get(`/transport/annotations?${q}`)
		return r.result?.annotations || { notes: [], tags: [], sections: [] }
	}

	// ─────────────────────────────────────────────── transport commands

	/** @param {Ref} t */
	static ref(t) {
		return { uid: String(t.uid || ''), name: String(t.name || '') }
	}

	/** @param {string} path @param {Ref[]} transports */
	simple(path, transports) {
		return this.post(path, { transports: transports.map((t) => DisguiseApi.ref(t)) })
	}

	/**
	 * @param {string} path
	 * @param {Ref[]} transports
	 * @param {Record<string, unknown>} extra
	 * @param {PlayMode} [playmode]
	 */
	withMode(path, transports, extra, playmode) {
		return this.post(path, {
			transports: transports.map((t) => ({
				transport: DisguiseApi.ref(t),
				...extra,
				playmode: normalizePlayMode(playmode),
			})),
		})
	}

	play(t) {
		return this.simple('/transport/play', t)
	}
	stop(t) {
		return this.simple('/transport/stop', t)
	}
	playSection(t) {
		return this.simple('/transport/playsection', t)
	}
	playLoopSection(t) {
		return this.simple('/transport/playloopsection', t)
	}
	returnToStart(t) {
		return this.simple('/transport/returntostart', t)
	}
	gotoNextSection(t, playmode) {
		return this.withMode('/transport/gotonextsection', t, {}, playmode)
	}
	gotoPrevSection(t, playmode) {
		return this.withMode('/transport/gotoprevsection', t, {}, playmode)
	}
	gotoNextTrack(t, playmode) {
		return this.withMode('/transport/gotonexttrack', t, {}, playmode)
	}
	gotoPrevTrack(t, playmode) {
		return this.withMode('/transport/gotoprevtrack', t, {}, playmode)
	}
	/** @param {Ref[]} t @param {string} section section index as string ("0", "1", …) */
	gotoSection(t, section, playmode) {
		return this.withMode('/transport/gotosection', t, { section: String(section) }, playmode)
	}
	gotoNote(t, note, playmode) {
		return this.withMode('/transport/gotonote', t, { note: String(note) }, playmode)
	}
	gotoTag(t, type, value, playmode, allowGlobalJump = false) {
		return this.withMode(
			'/transport/gototag',
			t,
			{ type: String(type), value: String(value), allowGlobalJump },
			playmode,
		)
	}
	/** @param {Ref[]} t @param {number} time seconds */
	gotoTime(t, time, playmode) {
		return this.withMode('/transport/gototime', t, { time: Number(time) }, playmode)
	}
	/** @param {Ref[]} t @param {string} timecode "HH:MM:SS:FF" (verified on r34) @param {boolean} [ignoreTags] */
	gotoTimecode(t, timecode, playmode, ignoreTags = false) {
		return this.withMode(
			'/transport/gototimecode',
			t,
			{ timecode: String(timecode), ignoreTags: !!ignoreTags },
			playmode,
		)
	}
	/** @param {Ref[]} t @param {Ref} track */
	gotoTrack(t, track, playmode) {
		return this.withMode('/transport/gototrack', t, { track: DisguiseApi.ref(track) }, playmode)
	}
	/** @param {Ref[]} t @param {boolean} engaged */
	setEngaged(t, engaged) {
		return this.post('/transport/engaged', {
			transports: t.map((x) => ({ transport: DisguiseApi.ref(x), engaged: !!engaged })),
		})
	}
	/** @param {Ref[]} t @param {number} volume 0..1 (values outside are silently ignored by the Director) */
	setVolume(t, volume) {
		return this.post('/transport/volume', {
			transports: t.map((x) => ({ transport: DisguiseApi.ref(x), volume: clamp01(volume) })),
		})
	}
	/** @param {Ref[]} t @param {number} brightness 0..1 */
	setBrightness(t, brightness) {
		return this.post('/transport/brightness', {
			transports: t.map((x) => ({ transport: DisguiseApi.ref(x), brightness: clamp01(brightness) })),
		})
	}
}

/** @param {unknown} v */
function clamp01(v) {
	const n = Number(v)
	return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

/** @param {unknown} v @returns {PlayMode} */
function normalizePlayMode(v) {
	const s = String(v ?? 'NotSet')
	return PLAY_MODES.includes(s) ? /** @type {PlayMode} */ (s) : 'NotSet'
}

module.exports = { DisguiseApi, PLAY_MODES, normalizePlayMode, clamp01 }
