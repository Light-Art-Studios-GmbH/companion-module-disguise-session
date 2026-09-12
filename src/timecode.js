/**
 * @file Timecode helpers: frame-rate clocks, HH:MM:SS:FF formatting (incl. SMPTE drop frame) and parsing.
 *
 * The Director tells us the transport's timecode format via `int(object.smpteClockType())`
 * (0 SMPTE23976, 1 SMPTE24, 2 SMPTE25, 3 SMPTE2997, 4 SMPTE2997DF, 5 SMPTE30 – verified on Designer r34).
 * The timeline refresh rate (customTimelineFps / d3.state.globalRefreshRate) is only the fallback.
 */

/** Standard rates; measured rates are snapped to the nearest one. */
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]

/** @typedef {{fps:number, dropFrame:boolean}} Clock */

/** @type {Clock} */
const DEFAULT_CLOCK = { fps: 25, dropFrame: false }

/**
 * Designer's d3.Timecode clock types.
 * @param {number} type
 * @returns {Clock|undefined}
 */
function clockFromSmpteType(type) {
	switch (Number(type)) {
		case 0:
			return { fps: 23.976, dropFrame: false }
		case 1:
			return { fps: 24, dropFrame: false }
		case 2:
			return { fps: 25, dropFrame: false }
		case 3:
			return { fps: 29.97, dropFrame: false }
		case 4:
			return { fps: 29.97, dropFrame: true }
		case 5:
			return { fps: 30, dropFrame: false }
		default:
			return undefined
	}
}

/**
 * A rate from Live Update: a number (customTimelineFps) or a FrameRateFraction {numerator, denominator}.
 * @param {unknown} v
 * @returns {Clock|undefined}
 */
function clockFromRate(v) {
	let rate
	if (typeof v === 'number') rate = v
	else if (v && typeof v === 'object' && 'numerator' in v) {
		const f = /** @type {{numerator:number, denominator:number}} */ (v)
		rate = f.denominator ? f.numerator / f.denominator : undefined
	}
	if (!rate || !Number.isFinite(rate) || rate <= 0) return undefined
	return { fps: snapFps(rate), dropFrame: false }
}

/** @param {number} measured */
function snapFps(measured) {
	if (!Number.isFinite(measured) || measured <= 0) return DEFAULT_CLOCK.fps
	return STANDARD_FPS.reduce(
		(best, f) => (Math.abs(f - measured) < Math.abs(best - measured) ? f : best),
		STANDARD_FPS[0],
	)
}

/** @param {Clock} c */
function clockLabel(c) {
	const fps = Number.isInteger(c.fps) ? String(c.fps) : c.fps.toFixed(3).replace(/0+$/, '')
	return `${fps}${c.dropFrame ? ' DF' : ''}`
}

/** @param {number} n */
function pad2(n) {
	return String(n).padStart(2, '0')
}

/**
 * Splits seconds into hours, minutes, seconds and frames (drop-frame aware).
 * @param {number} seconds
 * @param {Clock} clock
 * @returns {{h:number, m:number, s:number, f:number, drop:boolean}}
 */
function splitTime(seconds, clock) {
	const c = clock || DEFAULT_CLOCK
	const t = Math.max(0, Number(seconds) || 0)
	const isDropRate = Math.abs(c.fps - 29.97) < 0.01 || Math.abs(c.fps - 59.94) < 0.01
	if (c.dropFrame && isDropRate) return splitDropFrame(t, c.fps)
	const h = Math.floor(t / 3600)
	const m = Math.floor((t % 3600) / 60)
	const s = Math.floor(t % 60)
	const f = Math.floor((t - Math.floor(t)) * c.fps + 1e-6)
	return { h, m, s, f, drop: false }
}

/**
 * SMPTE drop-frame: count real frames at 30000/1001 (or 60000/1001), then skip frame numbers 0–1
 * (0–3 at 59.94) at the start of every minute except every tenth.
 * @param {number} seconds
 * @param {number} fps
 */
function splitDropFrame(seconds, fps) {
	const nominal = fps > 40 ? 60 : 30
	const drop = fps > 40 ? 4 : 2
	const exact = (nominal * 1000) / 1001
	let frame = Math.floor(seconds * exact + 1e-6)
	const perMinute = nominal * 60 - drop
	const perTenMinutes = nominal * 600 - drop * 9
	const tens = Math.floor(frame / perTenMinutes)
	const rest = frame % perTenMinutes
	frame += drop * 9 * tens + (rest >= drop ? drop * Math.floor((rest - drop) / perMinute) : 0)
	return {
		f: frame % nominal,
		s: Math.floor(frame / nominal) % 60,
		m: Math.floor(frame / (nominal * 60)) % 60,
		h: Math.floor(frame / (nominal * 3600)),
		drop: true,
	}
}

/**
 * Seconds → HH:MM:SS:FF (HH:MM:SS;FF for drop frame).
 * @param {number} seconds
 * @param {Clock} clock
 */
function toTimecode(seconds, clock) {
	const p = splitTime(seconds, clock)
	return `${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}${p.drop ? ';' : ':'}${pad2(p.f)}`
}

/** Seconds → HH:MM:SS */
function toHms(seconds) {
	const t = Math.max(0, Number(seconds) || 0)
	return `${pad2(Math.floor(t / 3600))}:${pad2(Math.floor((t % 3600) / 60))}:${pad2(Math.floor(t % 60))}`
}

/**
 * Parses "12.5" (seconds), "MM:SS", "HH:MM:SS", "HH:MM:SS:FF" or "HH:MM:SS;FF" into seconds.
 * @param {unknown} text
 * @param {Clock} clock frame rate used for the FF part
 * @returns {number|undefined}
 */
function parseTime(text, clock) {
	const s = String(text ?? '')
		.trim()
		.replace(',', '.')
	if (!s) return undefined
	if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s)
	const m = /^(\d+)(?::(\d+))?(?::(\d+))?(?:[:;.](\d+))?$/.exec(s)
	if (!m) return undefined
	const parts = s.split(/[:;]/)
	if (parts.length < 2) return undefined
	const nums = parts.map((p) => Number(p))
	if (nums.some((n) => !Number.isFinite(n))) return undefined
	const fps = (clock || DEFAULT_CLOCK).fps
	const padded =
		nums.length === 2 ? [0, nums[0], nums[1], 0] : nums.length === 3 ? [nums[0], nums[1], nums[2], 0] : nums
	const [h, mi, se, f] = padded
	return h * 3600 + mi * 60 + se + f / fps
}

module.exports = {
	STANDARD_FPS,
	DEFAULT_CLOCK,
	clockFromSmpteType,
	clockFromRate,
	clockLabel,
	snapFps,
	splitTime,
	toTimecode,
	toHms,
	parseTime,
	pad2,
}
