/**
 * Checks the editor workflow: switch commands to the editor, role states, lock/independent, section split/merge at
 * the playhead of the editor's GUI transport, and back to the Director.
 * Usage: DIRECTOR=<director-ip> EDITOR=<editor-ip> node scripts/editor-check.js
 */
const base = require('@companion-module/base')
class Stub {
	constructor() {
		this.label = 'd3'
		this.vars = {}
	}
	log(l, m) {
		if (l !== 'debug') console.log(`  [${l}] ${m}`)
	}
	updateStatus(s, m) {
		console.log(`  <status ${s}> ${m || ''}`)
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
		host3: process.env.EDITOR || '',
		port: 80,
		cacheAllTracks: true,
	})
	await sleep(3500)
	inst.lastHostCheck = 0
	await inst.checkHosts()
	expect(
		'director host state',
		inst.hosts.primary.state === 'director',
		`${inst.hosts.primary.machine} ${inst.hosts.primary.state}`,
	)
	expect(
		'editor host state',
		inst.hosts.editor?.state === 'editor',
		`${inst.hosts.editor?.machine} ${inst.hosts.editor?.state}`,
	)
	await inst.useHostOption('editor')
	await sleep(3500)
	expect(
		'commands go to the editor',
		inst.activeHostKey === 'editor' && inst.session.connected,
		`${inst.activeHost} connected=${inst.session.connected} live=${inst.live?.connected}`,
	)
	expect(
		'editor GUI transport known',
		!!inst.gui.transport,
		`gui transport ${inst.gui.transport}, selected: ${inst.gui.selectedLayers.join(', ') || '–'}`,
	)
	const ctx = inst.editContext()
	expect('edit context = GUI transport', ctx && ctx.t.name === inst.gui.transport, ctx?.t.name)

	// lock / independent
	await inst.editorMode('independent')
	await sleep(600)
	expect('independent playback', inst.editor.locked === false)
	await inst.editorMode('lock')
	await sleep(600)
	expect('locked to Director', inst.editor.locked === true)

	// section split / merge at the playhead of the GUI transport
	const t = ctx.t
	await inst.api.stop([t])
	await inst.gotoTimeText([t], '37', 'Stop')
	await sleep(500)
	const secsBefore = (inst.cuelists.get(t.trackUid) || []).filter((c) => c.kind === 'section').map((c) => c.time)
	await inst.sectionSplit([t], 'split')
	await sleep(800)
	const secsAfter = (inst.cuelists.get(t.trackUid) || []).filter((c) => c.kind === 'section').map((c) => c.time)
	expect(
		'split created a boundary at 37 s',
		secsAfter.some((x) => Math.abs(x - 37) < 0.05) && secsAfter.length === secsBefore.length + 1,
		`${secsBefore.join(',')} → ${secsAfter.join(',')}`,
	)
	await inst.gotoTimeText([t], '40', 'Stop')
	await sleep(500)
	await inst.sectionSplit([t], 'merge')
	await sleep(800)
	const secsMerged = (inst.cuelists.get(t.trackUid) || []).filter((c) => c.kind === 'section').map((c) => c.time)
	expect(
		'merge removed the boundary of the current section (37 s)',
		!secsMerged.some((x) => Math.abs(x - 37) < 0.05) && secsMerged.length === secsBefore.length,
		secsMerged.join(','),
	)

	await inst.useHostOption('director')
	await sleep(3000)
	expect('back to the Director', inst.activeHostKey === 'primary' && inst.session.connected, `${inst.activeHost}`)
	await inst.destroy()
	console.log(failures ? `${failures} FAILED` : 'all checks passed')
	process.exitCode = failures ? 1 : 0
})().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
