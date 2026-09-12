/**
 * Checks tags/notes at the playhead, section crossfade and insert/remove time on the active transport's track.
 * Everything is undone afterwards. Usage: DIRECTOR=<director-ip> node scripts/track-edit-check.js
 */
const base = require('@companion-module/base')
class Stub {
	constructor() {
		this.label = 'd3'
		this.vars = {}
	}
	log(l, m) {
		if (l !== 'debug' && !/Connected to|Live Update connected|Active transport/.test(m)) console.log(`  [${l}] ${m}`)
	}
	updateStatus() {}
	setVariableValues(v) {
		Object.assign(this.vars, v)
	}
	setVariableDefinitions() {}
	setActionDefinitions() {}
	setFeedbackDefinitions() {}
	setPresetDefinitions() {}
	checkFeedbacks() {}
}
require.cache[require.resolve('@companion-module/base')].exports = {
	...base,
	InstanceBase: Stub,
}
const { DisguiseInstance } = require('../src/instance.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const expect = (what, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
	if (!ok) failures++
}
const inst = new DisguiseInstance({})
;(async () => {
	await inst.init({
		host: process.env.DIRECTOR || '',
		port: 80,
		cacheAllTracks: true,
	})
	await sleep(3000)
	const t = inst.resolveTargets('active')
	const T = t[0]
	const cues = () => inst.cuelists.get(T.trackUid) || []
	await inst.api.stop(t)
	await inst.gotoTimeText(t, '200', 'Stop')
	await sleep(500)

	// tags and note at the playhead
	await inst.addAnnotation(t, { kind: 'cue', text: '77' })
	await inst.addAnnotation(t, { kind: 'note', text: 'companion note' })
	await inst.gotoTimeText(t, '201', 'Stop')
	await sleep(400)
	await inst.addAnnotation(t, { kind: 'midi', text: '5' })
	await inst.gotoTimeText(t, '202', 'Stop')
	await sleep(400)
	await inst.addAnnotation(t, { kind: 'tc', text: '03:00:00:00' })
	await sleep(600)
	const c = cues()
	expect(
		'CUE 77 at 200 s',
		c.some((x) => x.kind === 'tag' && x.tagType === 'CUE' && x.text === '77' && Math.abs(x.time - 200) < 0.05),
	)
	expect(
		'note at 200 s',
		c.some((x) => x.kind === 'note' && x.text === 'companion note' && Math.abs(x.time - 200) < 0.05),
	)
	expect(
		'MIDI 5 at 201 s',
		c.some((x) => x.kind === 'tag' && x.tagType === 'MIDI' && x.text === '5' && Math.abs(x.time - 201) < 0.05),
	)
	expect(
		'TC tag at 202 s',
		c.some((x) => x.kind === 'tag' && x.tagType === 'TC' && Math.abs(x.time - 202) < 0.05),
	)

	// crossfade of the section at the playhead (section containing 200 s)
	await inst.sectionCrossfade(t, { mode: 'fade', seconds: '1.5', loop: true })
	await inst.sectionCrossfade(t, { mode: 'undefined' })

	// insert / remove time
	const len0 = inst.tracks.get(T.trackUid)?.length
	await inst.insertTime(t, { seconds: '3', layers: 'move', remove: false })
	await sleep(800)
	const len1 = inst.tracks.get(T.trackUid)?.length
	expect('insert 3 s lengthened the track', len1 === len0 + 3, `${len0} → ${len1}`)
	await inst.insertTime(t, { seconds: '3', layers: 'move', remove: true })
	await sleep(800)
	expect(
		'remove 3 s restored the length',
		inst.tracks.get(T.trackUid)?.length === len0,
		`${inst.tracks.get(T.trackUid)?.length}`,
	)

	// cleanup: remove the test tags and note (Track.removeTagAtBeat / removeNoteAtBeat)
	const bps = 'object.player.track.bpm / 60.0'
	const D3 = "__import__('d3')"
	await inst.pyOnce(
		`object.player.track.removeTagAtBeat(200 * ${bps}, ${D3}.Tag.CUE) or object.player.track.removeNoteAtBeat(200 * ${bps}) or object.player.track.removeTagAtBeat(201 * ${bps}, ${D3}.Tag.MIDI) or object.player.track.removeTagAtBeat(202 * ${bps}, ${D3}.Tag.TC) or 'cleaned'`,
		`transportmanager:${T.name}`,
	)
	await inst.loadAnnotationsFor(T.trackUid)
	expect('test tags removed', !cues().some((x) => x.time >= 200 && x.time <= 202 && x.kind !== 'section'))
	await inst.api.returnToStart(t)
	await inst.destroy()
	console.log(failures ? `${failures} FAILED` : 'all checks passed')
	process.exitCode = failures ? 1 : 0
})().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
