/**
 * Checks the static assign commands on the layer selected in the Designer GUI (values are restored afterwards).
 * Usage: DIRECTOR=<director-ip> node scripts/layer-assign-check.js
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
const inst = new DisguiseInstance({})
const read = (t) =>
	inst.forSelected(
		t[0],
		"str(l.name) + ' blend=' + str([str(o) for o in l.findSequence('blendMode').options()][int(l.module.blendMode)]) + ' mode=' + str([str(o) for o in l.findSequence('mode').options()][int(l.module.mode)]) + ' end=' + str([str(o) for o in l.findSequence('at end point').options()][int(l.findSequence('at end point').sequence.key(0).v)]) + ' map=' + str(l.module.mapping.description) + ' speed=' + str(l.module.speed) + ' static=' + str(l.findSequence('blendMode').disableSequencing)",
	)
;(async () => {
	await inst.init({
		host: process.env.DIRECTOR || '',
		port: 80,
		cacheAllTracks: true,
	})
	await sleep(3000)
	const t = inst.resolveTargets('active')
	console.log('selected:', inst.gui.selectedLayers.join(', ') || '–')
	const before = await read(t)
	console.log('before:', before)
	await inst.layerAssign(t, 'blendMode', 'Add')
	await inst.layerAssign(t, 'mode', 'Locked')
	await inst.layerAssign(t, 'at end point', 'Pause')
	await inst.layerAssign(t, 'speed', '2')
	if (inst.mappings[0]) await inst.layerAssign(t, 'mapping', inst.mappings[0])
	await sleep(800)
	console.log('after assign:', await read(t))
	await inst.layerAssign(t, 'blendMode', 'Alpha')
	await inst.layerAssign(t, 'mode', 'Normal')
	await inst.layerAssign(t, 'at end point', 'Loop')
	await inst.layerAssign(t, 'speed', '1')
	await sleep(800)
	console.log('restored:', await read(t))
	await inst.destroy()
})().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
