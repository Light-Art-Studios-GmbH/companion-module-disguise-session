/**
 * @file Cuelist logic: flattens Designer annotations (sections, notes, tags) into a time-sorted list and
 * answers "which section / cue is the playhead in", "which comes next", "find a cue by text".
 *
 * Designer's annotations endpoint returns
 *   sections: [{time, index:"0", …}], notes: [{time, text}], tags: [{time, type:"CUE"|"MIDI"|…, value}]
 * A note that sits exactly on a section start is that section's name (this is how Designer shows it).
 */

/** Tolerance in seconds when comparing annotation times with the playhead. */
const EPS = 0.0005

/**
 * @typedef {object} CueItem
 * @property {'section'|'tag'|'note'} kind
 * @property {number} time seconds
 * @property {string} text display text: section name (or "Section N"), tag value or note text
 * @property {string} [index] section index ("0", "1", …)
 * @property {string} [name] section name (note on the section start), '' when unnamed
 * @property {string} [tagType] tag type (CUE, MIDI, …)
 */

/**
 * @param {{sections?:any[], notes?:any[], tags?:any[]}|undefined} a
 * @returns {CueItem[]}
 */
function buildCuelist(a) {
	/** @type {CueItem[]} */
	const items = []
	if (!a) return items
	const sections = Array.isArray(a.sections) ? a.sections : []
	const notes = Array.isArray(a.notes) ? a.notes : []
	const tags = Array.isArray(a.tags) ? a.tags : []
	const usedNotes = new Set()
	for (const s of sections) {
		const time = Number(s.time) || 0
		const noteIdx = notes.findIndex((n, i) => !usedNotes.has(i) && Math.abs((Number(n.time) || 0) - time) < EPS)
		if (noteIdx >= 0) usedNotes.add(noteIdx)
		const index = String(s.index ?? '')
		const name = noteIdx >= 0 ? String(notes[noteIdx].text ?? '') : ''
		items.push({ kind: 'section', time, index, name, text: name || `Section ${index}` })
	}
	for (const t of tags) {
		items.push({ kind: 'tag', time: Number(t.time) || 0, text: String(t.value ?? ''), tagType: String(t.type ?? '') })
	}
	notes.forEach((n, i) => {
		if (usedNotes.has(i)) return
		items.push({ kind: 'note', time: Number(n.time) || 0, text: String(n.text ?? '') })
	})
	const rank = { section: 0, tag: 1, note: 2 }
	return items.sort((x, y) => x.time - y.time || rank[x.kind] - rank[y.kind])
}

/** @param {CueItem[]} cues */
function sections(cues) {
	return cues.filter((c) => c.kind === 'section')
}

/**
 * The section the playhead is in (last section starting at or before `time`).
 * @param {CueItem[]} cues
 * @param {number} time
 * @returns {CueItem|undefined}
 */
function sectionAt(cues, time) {
	let found
	for (const c of cues) {
		if (c.kind !== 'section') continue
		if (c.time <= time + EPS) found = c
		else break
	}
	return found
}

/**
 * The next section after the playhead.
 * @param {CueItem[]} cues
 * @param {number} time
 */
function sectionAfter(cues, time) {
	return cues.find((c) => c.kind === 'section' && c.time > time + EPS)
}

/**
 * Section `delta` sections away from the current one (delta 0 = start of the current section,
 * −1 = previous section, +2 = the section after next). Clamped to the first/last section.
 * @param {CueItem[]} cues
 * @param {number} time
 * @param {number} delta
 * @returns {CueItem|undefined}
 */
function sectionByOffset(cues, time, delta) {
	const list = sections(cues)
	if (list.length === 0) return undefined
	let cur = -1
	list.forEach((s, i) => {
		if (s.time <= time + EPS) cur = i
	})
	// Before the first section: "next" means the first section, "previous" stays at the first one.
	const base = cur < 0 ? (delta > 0 ? -1 : 0) : cur
	const target = Math.max(0, Math.min(list.length - 1, base + delta))
	return list[target]
}

/**
 * The last cue (tag or note, not a section) at or before the playhead.
 * @param {CueItem[]} cues
 * @param {number} time
 */
function cueAt(cues, time) {
	let found
	for (const c of cues) {
		if (c.kind === 'section') continue
		if (c.time <= time + EPS) found = c
		else break
	}
	return found
}

/**
 * The next cue (tag or note) after the playhead.
 * @param {CueItem[]} cues
 * @param {number} time
 */
function cueAfter(cues, time) {
	return cues.find((c) => c.kind !== 'section' && c.time > time + EPS)
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @param {'exact'|'starts'|'contains'} mode
 */
function textMatches(haystack, needle, mode) {
	const h = String(haystack ?? '')
		.trim()
		.toLowerCase()
	const n = String(needle ?? '')
		.trim()
		.toLowerCase()
	if (!n) return false
	if (mode === 'contains') return h.includes(n)
	if (mode === 'starts') return h.startsWith(n)
	return h === n
}

/**
 * Finds a cue by text. `kind` restricts the search:
 *   'tag'       any tag value (cue numbers, MIDI, timecode tags)
 *   'tag:CUE'   tags of one type only (CUE, MIDI, TC, …)
 *   'note'      note text only
 *   'section'   section names, then section indices
 *   'auto'      tags first, then notes, then section names, then section indices
 * Numbers are compared numerically as well, so "1" also finds a CUE tag "1.00" and section "01".
 * @param {CueItem[]} cues
 * @param {string} text
 * @param {{kind?:string, match?:'exact'|'starts'|'contains'}} [opts]
 * @returns {CueItem|undefined}
 */
function findCue(cues, text, opts = {}) {
	const kind = String(opts.kind || 'auto')
	const mode = opts.match || 'exact'
	const needle = String(text ?? '').trim()
	if (!needle) return undefined
	const num = /^[+-]?\d+(\.\d+)?$/.test(needle) ? Number(needle) : undefined
	const numEq = (v) => num !== undefined && /^[+-]?\d+(\.\d+)?$/.test(String(v).trim()) && Number(v) === num
	const tagType = kind.startsWith('tag:') ? kind.slice(4).toUpperCase() : undefined

	const byTag = () =>
		cues.find(
			(c) =>
				c.kind === 'tag' &&
				(!tagType || String(c.tagType).toUpperCase() === tagType) &&
				(textMatches(c.text, needle, mode) || numEq(c.text)),
		)
	const byNote = () => cues.find((c) => c.kind === 'note' && textMatches(c.text, needle, mode))
	const bySectionName = () => cues.find((c) => c.kind === 'section' && c.name && textMatches(c.name, needle, mode))
	const bySectionIndex = () =>
		cues.find((c) => c.kind === 'section' && (numEq(c.index) || textMatches(c.index, needle, 'exact')))

	if (tagType || kind === 'tag') return byTag()
	switch (kind) {
		case 'note':
			return byNote()
		case 'section':
			return bySectionName() || bySectionIndex()
		default:
			return byTag() || byNote() || bySectionName() || bySectionIndex()
	}
}

module.exports = {
	EPS,
	buildCuelist,
	sections,
	sectionAt,
	sectionAfter,
	sectionByOffset,
	cueAt,
	cueAfter,
	findCue,
	textMatches,
}
