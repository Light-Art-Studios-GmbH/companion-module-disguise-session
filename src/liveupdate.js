/**
 * @file Live Update websocket client (ws://<director>/api/session/liveupdate).
 *
 * Verified on Designer r34.0.3:
 *   • object paths are `transportmanager:<name>`; spaces in the name become underscores
 *   • property paths are Python expressions evaluated with `object` bound (eval); uids must be wrapped in str()
 *   • messages: {subscribe:{object, properties, configuration:{updateFrequencyMs}}}
 *     answers:  {subscriptions:[{id,objectPath,propertyPath}]}, then {valuesChanged:[{id,value,…}]} on change;
 *     per-property errors arrive as value:{errorType,message}; {unsubscribe:{ids:[…]}} removes subscriptions
 *   • the eval globals persist between evaluations, so an expression can be made single-shot (evalOnce): the
 *     Director evaluates every subscribed expression again at the update interval, a guard in globals() makes
 *     sure a command (e.g. addNewLayer, setattr) runs exactly once
 *   • multitransports have no transportmanager object – only real transports are subscribed
 *
 * Groups: `setGroups([{tag, objectPath, props:{key: expression}, updateMs?}])` keeps the subscriptions in sync.
 * Emits: 'open', 'close' (reason), 'update' ({tag, objectPath, name, values:{key:value}}), 'error' (message).
 * Reconnects on its own until stop() is called.
 */
const { EventEmitter } = require('node:events')

/** Property key → Designer expression, per transport. */
const TRANSPORT_PROPS = {
	uid: 'str(object.uid)',
	time: 'object.player.tRender',
	playing: 'object.player.playing',
	state: 'object.player.playMode.state',
	trackUid: 'str(object.player.track.uid)',
	trackName: 'str(object.player.track.description)',
	engaged: 'object.engaged',
	volume: 'object.volume',
	brightness: 'object.brightness',
	rate: "(object.customTimelineFps if object.enableCustomFps else __import__('d3').state.globalRefreshRate)",
	smpte: 'int(object.smpteClockType())',
	tcStatus: 'str(object.tcStatusString)',
	tcSource: "(object.timecode.__class__.__name__.replace('TimecodeTransport', '').upper() if object.timecode else '')",
	tcIncoming: "(str(object.timecode.current) if object.timecode else '')",
	tcIncomingSeconds: '(object.timecode.current.t if object.timecode else -1)',
}

/** Director-wide values (subscribed once, on any transport object). */
const D3 = "__import__('d3')"
const GLOBAL_PROPS = {
	masterOutput: `int(${D3}.state.localOrDirectorState().output)`,
	fadeDuration: `${D3}.state.fadeDurationSec`,
	thisMachine: `str(${D3}.d3NetManager.localMachine.description)`,
	directorMachine: `(str(${D3}.d3NetManager.director.description) if ${D3}.d3NetManager.director else '')`,
	directorMode: `${D3}.d3NetManager.directorMode`,
	editorMode: `${D3}.d3NetManager.mobileEditorMode`,
	actorMode: `${D3}.d3NetManager.actorMode`,
	projectName: `str(${D3}.d3.projectName)`,
	layerTypes: `[[m[:-6], str(getattr(getattr(${D3}, m), '__username__', m))[:-6] if str(getattr(getattr(${D3}, m), '__username__', m)).endswith('Module') else str(getattr(getattr(${D3}, m), '__username__', m))] for m in dir(${D3}) if m.endswith('Module') and not m.startswith('Array') and m != 'Module']`,
	guiTransport: `str(${D3}.guisystem.currentTransportManager.description)`,
	lockedToDirector: `bool(${D3}.state.lockedToDirector)`,
	mappings: `[str(m.description) for m in ${D3}.resourceManager.allResources(${D3}.Projection) if not str(m.path).startswith('internal/')]`,
	noteLists: `[str(n.description) for n in ${D3}.resourceManager.allResources(${D3}.Note) if not str(n.path).startswith('internal/')]`,
	blendModes: `([str(o) for o in ${D3}.resourceManager.allResources(${D3}.Layer)[0].findSequence('blendMode').options()] if len(${D3}.resourceManager.allResources(${D3}.Layer)) and ${D3}.resourceManager.allResources(${D3}.Layer)[0].findSequence('blendMode') else [])`,
	selectedLayers: `[str(l.name) for l in ${D3}.guisystem.selectedLayers if l]`,
}
/** Expressions the role probe asks a host for (which machine am I talking to, is it the Director). */
const ROLE_PROPS = {
	thisMachine: GLOBAL_PROPS.thisMachine,
	directorMachine: GLOBAL_PROPS.directorMachine,
	directorMode: GLOBAL_PROPS.directorMode,
	editorMode: GLOBAL_PROPS.editorMode,
	actorMode: GLOBAL_PROPS.actorMode,
	lockedToDirector: GLOBAL_PROPS.lockedToDirector,
}

/** Role name from the d3NetManager flags. */
function roleOf(v) {
	if (v.directorMode) return 'director'
	if (v.editorMode) return 'editor'
	if (v.actorMode) return 'actor'
	return 'online'
}

/** "IMAG Screens" → "IMAG_Screens": Designer's object-path form of a resource name. */
function objectPathName(name) {
	return String(name ?? '')
		.trim()
		.replace(/\s+/g, '_')
}

/** Python string literal. */
function pyStr(s) {
	return JSON.stringify(String(s ?? ''))
}

/**
 * Wraps an expression so the Director evaluates it once; later evaluations return the cached result.
 * @param {string} key unique key
 * @param {string} expr
 */
function onceExpr(key, expr) {
	const k = pyStr(key)
	return `(globals()['_companion_once'][${k}] if ${k} in globals().setdefault('_companion_once', {}) else (globals()['_companion_once'].__setitem__(${k}, str(${expr})) or globals()['_companion_once'][${k}]))`
}

const RETRY_MS = [1000, 2000, 5000, 10000]
const ONCE_INTERVAL_MS = 600000
let onceCounter = 0

class LiveUpdate extends EventEmitter {
	/**
	 * @param {{host:string, port?:number, updateMs?:number, log?:(level:string, msg:string)=>void}} opts
	 */
	constructor(opts) {
		super()
		this.host = String(opts.host || '').trim()
		this.port = Number(opts.port) || 80
		this.updateMs = Math.max(10, Number(opts.updateMs) || 40)
		this.log = opts.log || (() => {})
		/** @type {WebSocket|null} */
		this.ws = null
		/** @type {Map<string, {tag:string, objectPath:string, props:Record<string,string>, updateMs?:number}>} groupId → group */
		this.groups = new Map()
		/** @type {Set<string>} group ids subscribed on the open socket */
		this.subscribedGroups = new Set()
		/** @type {Map<string, {tag:string, key:string, objectPath:string, once?:(v:unknown)=>void}>} objectPath|propertyPath → info */
		this.pending = new Map()
		/** @type {Map<number, {tag:string, key:string, objectPath:string, once?:(v:unknown)=>void}>} subscription id → info */
		this.subs = new Map()
		this.stopped = true
		this.retries = 0
		this.retryTimer = null
		this.connected = false
		/** Subscribe messages are sent one at a time (Designer rejects back-to-back frames with "Invalid JSON"). */
		this.queue = []
		this.inflight = null
	}

	/** Queues a subscribe message; the next one goes out after the reply (or 250 ms). */
	sendQueued(msg) {
		this.queue.push(msg)
		this.pump()
	}

	pump() {
		const ws = this.ws
		if (this.inflight || !ws || ws.readyState !== 1 || this.queue.length === 0) return
		const msg = this.queue.shift()
		try {
			ws.send(JSON.stringify(msg))
		} catch (e) {
			this.emit('error', `Live Update send: ${e?.message || e}`)
			return
		}
		this.inflight = setTimeout(() => {
			this.inflight = null
			this.pump()
		}, 250)
	}

	/** Called when the Director answered the message in flight. */
	replied() {
		if (this.inflight) clearTimeout(this.inflight)
		this.inflight = null
		this.pump()
	}

	get url() {
		const hostPort = this.port === 80 ? this.host : `${this.host}:${this.port}`
		return `ws://${hostPort}/api/session/liveupdate`
	}

	start() {
		this.stopped = false
		if (!this.ws) this.open()
		else this.syncSubscriptions()
	}

	/**
	 * Replaces the wanted subscriptions. Unchanged groups keep their subscription.
	 * @param {{tag:string, objectPath:string, props:Record<string,string>, updateMs?:number}[]} groups
	 */
	setGroups(groups) {
		const next = new Map()
		for (const g of groups) next.set(`${g.tag}|${g.objectPath}`, g)
		// unsubscribe groups that are gone
		const gone = []
		for (const [id, g] of this.groups) {
			if (next.has(id)) continue
			for (const [subId, info] of this.subs)
				if (info.tag === g.tag && info.objectPath === g.objectPath && !info.once) gone.push(subId)
		}
		if (gone.length && this.ws && this.ws.readyState === 1) {
			try {
				this.ws.send(JSON.stringify({ unsubscribe: { ids: gone } }))
			} catch {
				// ignore
			}
		}
		for (const subId of gone) this.subs.delete(subId)
		for (const id of this.groups.keys()) if (!next.has(id)) this.subscribedGroups.delete(id)
		this.groups = next
		if (this.stopped) return
		if (!this.ws) this.open()
		else this.syncSubscriptions()
	}

	stop() {
		this.stopped = true
		this.queue = []
		if (this.inflight) clearTimeout(this.inflight)
		this.inflight = null
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = null
		const ws = this.ws
		this.ws = null
		this.subscribedGroups.clear()
		this.subs.clear()
		this.pending.clear()
		this.connected = false
		if (ws) {
			try {
				ws.close()
			} catch {
				// ignore
			}
		}
	}

	open() {
		if (this.stopped || this.ws) return
		if (typeof WebSocket !== 'function') {
			this.emit('error', 'WebSocket is not available in this Node runtime')
			return
		}
		let ws
		try {
			ws = new WebSocket(this.url)
		} catch (e) {
			this.emit('error', `Live Update: ${e?.message || e}`)
			this.scheduleRetry()
			return
		}
		this.ws = ws
		this.subscribedGroups.clear()
		this.subs.clear()
		this.pending.clear()
		ws.onopen = () => {
			if (this.ws !== ws) return
			this.connected = true
			this.retries = 0
			this.emit('open')
			this.syncSubscriptions()
		}
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return
			this.handleMessage(String(ev.data))
		}
		ws.onerror = () => {
			// onclose follows; the error event carries no useful message in Node
		}
		ws.onclose = (ev) => {
			if (this.ws !== ws) return
			this.ws = null
			this.queue = []
			if (this.inflight) clearTimeout(this.inflight)
			this.inflight = null
			this.connected = false
			this.subscribedGroups.clear()
			this.subs.clear()
			this.pending.clear()
			this.emit('close', ev?.reason || `code ${ev?.code ?? '?'}`)
			this.scheduleRetry()
		}
	}

	scheduleRetry() {
		if (this.stopped || this.retryTimer) return
		const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]
		this.retries++
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null
			this.open()
		}, delay)
	}

	/** Subscribes every wanted group that is not subscribed yet on the open socket. */
	syncSubscriptions() {
		const ws = this.ws
		if (!ws || ws.readyState !== 1) return
		for (const [id, g] of this.groups) {
			if (this.subscribedGroups.has(id)) continue
			this.subscribedGroups.add(id)
			for (const [key, expr] of Object.entries(g.props))
				this.pending.set(`${g.objectPath}|${expr}`, { tag: g.tag, key, objectPath: g.objectPath })
			this.sendQueued({
				subscribe: {
					object: g.objectPath,
					properties: Object.values(g.props),
					configuration: { updateFrequencyMs: g.updateMs || this.updateMs },
				},
			})
		}
	}

	/**
	 * Evaluates a Python expression once on the Director and resolves with its (stringified) result.
	 * @param {string} objectPath any existing object, e.g. transportmanager:default
	 * @param {string} expr
	 * @param {number} [timeoutMs]
	 * @returns {Promise<string>}
	 */
	evalOnce(objectPath, expr, timeoutMs = 5000) {
		return this.readRaw(objectPath, { result: onceExpr(`c${Date.now()}_${onceCounter++}`, expr) }, timeoutMs).then(
			(v) => {
				const r = v.result
				if (r && typeof r === 'object' && 'errorType' in r) throw new Error(String(r.message || r.errorType))
				return String(r)
			},
		)
	}

	/**
	 * Reads expressions once (no repeated updates).
	 * @param {string} objectPath
	 * @param {Record<string,string>} props key → expression
	 * @param {number} [timeoutMs]
	 * @returns {Promise<Record<string, unknown>>}
	 */
	readRaw(objectPath, props, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const ws = this.ws
			if (!ws || ws.readyState !== 1) return reject(new Error('Live Update not connected'))
			const wanted = Object.keys(props).length
			/** @type {Record<string, unknown>} */
			const values = {}
			let done = false
			const ids = []
			const finish = (err) => {
				if (done) return
				done = true
				clearTimeout(timer)
				if (ids.length && this.ws === ws && ws.readyState === 1) {
					try {
						ws.send(JSON.stringify({ unsubscribe: { ids } }))
					} catch {
						// ignore
					}
				}
				for (const id of ids) this.subs.delete(id)
				if (err) reject(err)
				else resolve(values)
			}
			const timer = setTimeout(() => finish(new Error(`Live Update read timed out after ${timeoutMs} ms`)), timeoutMs)
			const tag = `once:${Date.now()}_${onceCounter++}`
			for (const [key, expr] of Object.entries(props)) {
				this.pending.set(`${objectPath}|${expr}`, {
					tag,
					key,
					objectPath,
					once: (v) => {
						values[key] = v
						if (Object.keys(values).length >= wanted) finish()
					},
					onId: (id) => ids.push(id),
				})
			}
			this.sendQueued({
				subscribe: {
					object: objectPath,
					properties: Object.values(props),
					configuration: { updateFrequencyMs: ONCE_INTERVAL_MS },
				},
			})
		})
	}

	/** @param {string} data */
	handleMessage(data) {
		let msg
		try {
			msg = JSON.parse(data)
		} catch {
			return
		}
		if (msg.error) {
			this.replied()
			this.emit('error', `Live Update: ${msg.error}`)
			// a failed one-shot read must not hang: resolve pending once-entries with the error
			const m = /Unable to subscribe to (.+?) \/ (.+?) - /.exec(String(msg.error))
			if (m) {
				const info = this.pending.get(`${m[1]}|${m[2]}`)
				if (info?.once) {
					this.pending.delete(`${m[1]}|${m[2]}`)
					info.once({ errorType: 'subscribeError', message: msg.error })
				}
			}
			return
		}
		if (Array.isArray(msg.subscriptions)) {
			this.replied()
			for (const s of msg.subscriptions) {
				const k = `${s.objectPath}|${s.propertyPath}`
				const info = this.pending.get(k)
				if (!info) continue
				this.pending.delete(k)
				this.subs.set(Number(s.id), info)
				if (info.onId) info.onId(Number(s.id))
			}
			return
		}
		if (!Array.isArray(msg.valuesChanged)) return
		/** @type {Map<string, {tag:string, objectPath:string, values:Record<string, unknown>}>} */
		const perGroup = new Map()
		for (const v of msg.valuesChanged) {
			const sub = this.subs.get(Number(v.id))
			if (!sub) continue
			if (sub.once) {
				sub.once(v.value)
				continue
			}
			if (v.value && typeof v.value === 'object' && 'errorType' in v.value) {
				this.emit('error', `Live Update ${sub.objectPath} ${sub.key}: ${v.value.message || v.value.errorType}`)
				continue
			}
			const gk = `${sub.tag}|${sub.objectPath}`
			let g = perGroup.get(gk)
			if (!g) {
				g = { tag: sub.tag, objectPath: sub.objectPath, values: {} }
				perGroup.set(gk, g)
			}
			g.values[sub.key] = v.value
		}
		for (const g of perGroup.values()) {
			this.emit('update', { ...g, name: g.objectPath.replace(/^transportmanager:/, '') })
		}
	}
}

/**
 * Short-lived probe: which machine answers on `host` and is it the Director?
 * @param {{host:string, port?:number, objectPath:string, timeoutMs?:number}} opts
 * @returns {Promise<{machine:string, director:string, isDirector:boolean, role:string}>}
 */
function probeRole(opts) {
	return new Promise((resolve, reject) => {
		const lu = new LiveUpdate({ host: opts.host, port: opts.port })
		const timeoutMs = opts.timeoutMs || 4000
		let done = false
		const finish = (err, val) => {
			if (done) return
			done = true
			clearTimeout(timer)
			lu.stop()
			if (err) reject(err)
			else resolve(val)
		}
		const timer = setTimeout(() => finish(new Error('role probe timed out')), timeoutMs)
		lu.on('open', () => {
			lu.readRaw(opts.objectPath, ROLE_PROPS, timeoutMs - 200)
				.then((v) => {
					const bad = Object.values(v).find((x) => x && typeof x === 'object' && 'errorType' in x)
					if (bad) return finish(new Error(String(bad.message || bad.errorType)))
					finish(undefined, {
						machine: String(v.thisMachine ?? ''),
						director: String(v.directorMachine ?? ''),
						isDirector: !!v.directorMode,
						role: roleOf(v),
						locked: !!v.lockedToDirector,
					})
				})
				.catch((e) => finish(e))
		})
		lu.on('close', () => finish(new Error('websocket closed')))
		lu.on('error', () => {})
		lu.start()
	})
}

module.exports = { LiveUpdate, probeRole, roleOf, objectPathName, onceExpr, pyStr, TRANSPORT_PROPS, GLOBAL_PROPS, D3 }
