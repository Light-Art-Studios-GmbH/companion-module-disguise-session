/**
 * Checks the selected-layer commands against a Director; needs a layer selected in the Designer GUI.
 * Usage: DIRECTOR=<director-ip> node scripts/layer-fx-check.js
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
;(async () => {
	await inst.init({
		host: process.env.DIRECTOR || '',
		port: 80,
		cacheAllTracks: true,
	})
	await sleep(3000)
	const t = inst.resolveTargets('active')
	const ctx = inst.editContext()
	console.log(
		'active',
		t[0]?.name,
		'| edit host',
		inst.activeHost,
		'| edit transport',
		ctx?.t.name,
		'| selected:',
		inst.gui.selectedLayers.join(', '),
		'| blend modes',
		inst.blendModes.length,
		'| mappings',
		inst.mappings.length,
	)
	const cur = await inst.forSelected(
		t[0],
		"str(l.name) + ' blend=' + str([str(o) for o in l.findSequence('blendMode').options()][int(l.module.blendMode)]) + ' map=' + str(l.module.mapping.description) + ' keys=' + str(l.findSequence('brightness').sequence.nKeys()) + ' ext=' + str(l.tStart) + '-' + str(l.tEnd)",
	)
	console.log('before:', cur)
	const m = /blend=([^ ]+) map=(.+?) keys=/.exec(cur)
	if (m) {
		await inst.layerBlendMode(t, m[1])
		await inst.layerMapping(t, m[2])
	}
	await inst.layerFade(t, {
		property: 'opacity',
		anchor: 'start',
		from: '0',
		to: '1',
		seconds: '1',
	})
	await inst.layerFade(t, {
		property: 'opacity',
		anchor: 'end',
		from: '1',
		to: '0',
		seconds: '1',
	})
	console.log(
		'after fades (brightness):',
		await inst.forSelected(
			t[0],
			"str(l.name) + ' keys=' + str(l.findSequence('brightness').sequence.nKeys()) + ' keyTimes=' + str([round(x, 2) for x in l.keyTimes()]) + ' b@0.5=' + str(l.findSequence('brightness').eval(0.5, 0)) + ' b@end=' + str(l.findSequence('brightness').eval(l.tLength, 0))",
		),
	)
	if (process.env.CLEAR) {
		await inst.layerKeysClear(t, { property: 'opacity', value: '1' })
		console.log(
			'after clear:',
			await inst.forSelected(
				t[0],
				"str(l.name) + ' keys=' + str(l.findSequence('brightness').sequence.nKeys()) + ' keyTimes=' + str(l.keyTimes()) + ' static=' + str(l.findSequence('brightness').disableSequencing)",
			),
		)
	}
	await inst.layerFit(t)
	console.log('extents:', await inst.forSelected(t[0], "str(l.name) + ' ' + str(l.tStart) + '-' + str(l.tEnd)"))
	await inst.destroy()
})().catch((e) => {
	console.error(e)
	process.exitCode = 1
})
