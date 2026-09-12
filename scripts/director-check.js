/**
 * Integration check against a real Director (moves the playhead of the active transport!).
 * Usage: DIRECTOR=<director-ip> node scripts/director-check.js
 * Runs the instance class with a stubbed Companion host and exercises the command helpers.
 */
// Stub the Companion host: replace InstanceBase before the module is loaded.
const base = require('@companion-module/base')
class StubInstanceBase {
	constructor() {
		this.label = 'd3'
		this.vars = {}
		this.status = []
	}
	log(level, msg) {
		if (level !== 'debug') console.log(`  [${level}] ${msg}`)
	}
	updateStatus(s, m) {
		this.status.push([s, m])
	}
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
	InstanceBase: StubInstanceBase,
}
const { DisguiseInstance } = require('../src/instance.js')

const host = process.env.DIRECTOR
if (!host) {
	console.error('DIRECTOR=<ip> is required')
	process.exitCode = 2
	throw new Error('DIRECTOR missing')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inst = new DisguiseInstance({})

let failures = 0
const expect = (what, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`)
	if (!ok) failures++
}
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol

async function main() {
	await inst.init({ host, port: 80, cacheAllTracks: true })
	await sleep(1500)
	const t = inst.resolveTargets('active')[0]
	expect('connected', inst.session.connected, inst.status.at(-1)?.join(' '))
	expect('active transport resolved', !!t, t?.name)
	if (!t) return
	const cues = inst.cuelists.get(t.trackUid) || []
	expect(
		'cuelist loaded',
		cues.length > 0,
		`${cues.length} items, sections ${cues.filter((c) => c.kind === 'section').length}`,
	)
	expect('live time flowing', typeof inst.vars[`${t.key}_time_tc`] === 'string', inst.vars[`${t.key}_time_tc`])
	console.log(
		'  fps',
		inst.vars[`${t.key}_fps`],
		'track',
		inst.vars[`${t.key}_track`],
		'section',
		inst.vars[`${t.key}_section_index`],
	)

	const secs = cues.filter((c) => c.kind === 'section')
	if (secs.length < 3) {
		console.log('need at least 3 sections for the jump tests')
		return
	}
	await inst.api.stop([t])
	await inst.gotoTimeText([t], '00:00:40:00', 'Stop')
	await sleep(400)
	expect('goto time 40 s', near(t.time, 40), `time ${t.time}`)

	await inst.jumpSections([t], -1, 'NotSet')
	await sleep(400)
	const prev = secs.filter((s) => s.time <= 40 + 0.001).at(-2)
	expect(
		'jump -1 → start of previous section',
		prev && near(t.time, prev.time),
		`time ${t.time}, expected ${prev?.time}`,
	)

	await inst.jumpSections([t], 2, 'NotSet')
	await sleep(400)
	const idx = secs.findIndex((s) => s === prev)
	const target2 = secs[Math.min(secs.length - 1, idx + 2)]
	expect('jump +2', near(t.time, target2.time), `time ${t.time}, expected ${target2.time}`)

	await inst.gotoTimeText([t], String(target2.time + 5), 'Stop')
	await sleep(400)
	await inst.jumpSections([t], 0, 'NotSet')
	await sleep(400)
	expect('jump 0 → restart section', near(t.time, target2.time), `time ${t.time}`)

	const named = secs.find((s) => s.name)
	if (named) {
		await inst.gotoCue([t], named.name, { kind: 'section', match: 'exact', otherTracks: true }, 'Stop')
		await sleep(400)
		expect(`goto cue by section name "${named.name}"`, near(t.time, named.time), `time ${t.time}`)
	}
	await inst.gotoCue([t], secs[1].index, { kind: 'section', match: 'exact', otherTracks: false }, 'Stop')
	await sleep(400)
	expect(`goto section index ${secs[1].index}`, near(t.time, secs[1].time), `time ${t.time}`)
	const note = cues.find((c) => c.kind === 'note')
	if (note) {
		await inst.gotoCue([t], note.text.slice(0, 3), { kind: 'note', match: 'starts', otherTracks: false }, 'Stop')
		await sleep(400)
		expect(`goto note starting with "${note.text.slice(0, 3)}"`, near(t.time, note.time), `time ${t.time}`)
	}

	await inst.api.play([t])
	await sleep(1200)
	expect('play → playing', t.playing && t.playmode === 'Play', `playing ${t.playing} mode ${t.playmode} time ${t.time}`)
	await inst.api.stop([t])
	await sleep(400)
	expect('stop → stopped', !t.playing && t.playmode === 'Stop', `mode ${t.playmode}`)

	await inst.api.gotoNextSection([t], 'NotSet')
	await sleep(400)
	console.log('  native next section → time', t.time)

	const b0 = t.brightness
	await inst.setLevel([t], 'brightness', '50', false)
	await sleep(400)
	expect('brightness 50 %', near(t.brightness, 0.5, 0.02), `${t.brightness}`)
	await inst.setLevel([t], 'brightness', String(Math.round(b0 * 100)), false)
	await sleep(300)

	const e0 = t.engaged
	await inst.setEngaged([t], 'toggle')
	await sleep(400)
	expect('engage toggle', t.engaged === !e0, `${e0} → ${t.engaged}`)
	await inst.setEngaged([t], 'toggle')
	await sleep(400)
	expect('engage toggle back', t.engaged === e0, `${t.engaged}`)

	// ── new in 0.2: timecode, master output, machines, layers
	await inst.gotoTimecodeText([t], '00:00:25:12', true, 'Stop')
	await sleep(400)
	expect('goto timecode 00:00:25:12', near(t.time, 25.48, 0.1), `time ${t.time}`)
	await inst.gotoTimecodeText([t], '12', true, 'Stop')
	await sleep(400)
	expect('goto timecode from seconds', near(t.time, 12, 0.1), `time ${t.time}`)
	console.log('  tc source', JSON.stringify(t.tcSource), 'incoming', t.tcIncoming, 'status', t.tcStatus)
	expect(
		'machines from health',
		inst.machines.size >= 1,
		[...inst.machines.values()].map((m) => `${m.name}:${m.role}:${m.fps}fps:${m.state}`).join(', '),
	)
	expect(
		'primary host role probed',
		inst.hosts.primary.state === 'director',
		`${inst.hosts.primary.machine} ${inst.hosts.primary.state}`,
	)
	const m0 = inst.master.output
	await inst.masterFade('fadedown')
	await sleep(1200)
	expect('master fade down', inst.master.output === 0, `output ${inst.master.output}`)
	await inst.masterFade('fadeup')
	await sleep(1200)
	expect('master fade up', inst.master.output === 1, `output ${inst.master.output} (was ${m0})`)
	const layerNames = async () =>
		JSON.parse(await inst.pyOnce("__import__('json').dumps([str(l.name) for l in object.player.track.layers])"))
	console.log('  layer types', inst.layerTypes.length, 'layers', (await layerNames()).join(', '))
	await inst.layerAdd([t], {
		type: 'Colour',
		name: 'Companion check',
		length: '5',
		start: '',
		toSectionEnd: false,
	})
	await sleep(800)
	let names = await layerNames()
	expect('layer added', names.includes('Companion check'), names.join(', '))
	await inst.layerEnable([t], 'Companion check', 'off')
	await inst.layerExtents([t], 'Companion check', '30', '4')
	await inst.layerRemove([t], 'Companion check')
	await sleep(800)
	names = await layerNames()
	expect('layer removed', !names.includes('Companion check'), names.join(', '))
	await inst.layerRemove([t], 'Companion check') // must not throw (guarded)

	await inst.api.returnToStart([t])
	await sleep(400)
	expect('return to start', near(t.time, 0), `time ${t.time}`)
	console.log(
		'  vars sample:',
		[
			'time_tc',
			'section_index',
			'section_label',
			'section_remaining_tc',
			'next_section_label',
			'cue_next',
			'cue_next_remaining_tc',
		]
			.map((k) => `${k}=${inst.vars[`${t.key}_${k}`]}`)
			.join('  '),
	)
}

main()
	.catch((e) => {
		console.error(e)
		failures++
	})
	.finally(async () => {
		await inst.destroy()
		console.log(failures ? `${failures} FAILED` : 'all checks passed')
		process.exitCode = failures ? 1 : 0
	})
