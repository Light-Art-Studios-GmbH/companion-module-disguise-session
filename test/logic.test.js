/** Plain Node tests for the pure logic (run with `npm test`). */
const assert = require('node:assert/strict')
const tc = require('../src/timecode.js')
const cl = require('../src/cuelist.js')

// timecode
assert.equal(tc.toTimecode(0, { fps: 25, dropFrame: false }), '00:00:00:00')
assert.equal(tc.toTimecode(3661.5, { fps: 25, dropFrame: false }), '01:01:01:12')
assert.equal(tc.toTimecode(59.96, { fps: 25, dropFrame: false }), '00:00:59:24')
assert.equal(tc.toTimecode(60, { fps: 29.97, dropFrame: true }), '00:00:59;28')
assert.equal(tc.toTimecode(1800 / 29.97, { fps: 29.97, dropFrame: true }), '00:01:00;02')
assert.equal(tc.toTimecode(600, { fps: 29.97, dropFrame: true }), '00:10:00;00')
assert.equal(tc.toHms(3661.9), '01:01:01')
assert.equal(tc.parseTime('12.5', tc.DEFAULT_CLOCK), 12.5)
assert.equal(tc.parseTime('1:30', tc.DEFAULT_CLOCK), 90)
assert.equal(tc.parseTime('01:00:10', tc.DEFAULT_CLOCK), 3610)
assert.equal(tc.parseTime('00:00:01:05', { fps: 25, dropFrame: false }), 1.2)
assert.equal(tc.parseTime('00:00:01;15', { fps: 30, dropFrame: true }), 1.5)
assert.equal(tc.parseTime('abc', tc.DEFAULT_CLOCK), undefined)
assert.deepEqual(tc.clockFromSmpteType(4), { fps: 29.97, dropFrame: true })
assert.deepEqual(tc.clockFromRate({ numerator: 50, denominator: 1 }), { fps: 50, dropFrame: false })
assert.equal(tc.splitTime(1.999, { fps: 25, dropFrame: false }).f, 24)

// cuelist – like the test project on the Director: 4 sections, notes on 0 and 30
const a = {
	notes: [
		{ time: 0, text: 'Opening' },
		{ time: 30, text: 'Act one' },
		{ time: 50, text: 'standby lights' },
	],
	tags: [
		{ time: 45, type: 'CUE', value: '1.00' },
		{ time: 60, type: 'CUE', value: '2' },
		{ time: 12, type: 'MIDI', value: 'GO' },
	],
	sections: [
		{ time: 0, index: '0' },
		{ time: 30, index: '1' },
		{ time: 45, index: '2' },
		{ time: 60, index: '3' },
	],
}
const cues = cl.buildCuelist(a)
assert.equal(cues.length, 4 + 3 + 1) // 4 sections, 3 tags, 1 free note (2 notes became section names)
assert.equal(cues[0].kind, 'section')
assert.equal(cues[0].name, 'Opening')
assert.equal(cl.sectionAt(cues, 10).index, '0')
assert.equal(cl.sectionAt(cues, 30).index, '1')
assert.equal(cl.sectionAt(cues, 44.99).index, '1')
assert.equal(cl.sectionAfter(cues, 30).index, '2')
assert.equal(cl.sectionAfter(cues, 70), undefined)
// smart jumps
assert.equal(cl.sectionByOffset(cues, 40, -1).index, '0') // mid section 1 → previous = 0
assert.equal(cl.sectionByOffset(cues, 40, 0).index, '1') // restart current
assert.equal(cl.sectionByOffset(cues, 40, 1).index, '2')
assert.equal(cl.sectionByOffset(cues, 40, 10).index, '3') // clamped
assert.equal(cl.sectionByOffset(cues, 5, -10).index, '0')
assert.equal(cl.sectionByOffset(cues, 61, -2).index, '1')
// cues
assert.equal(cl.cueAt(cues, 46).text, '1.00')
assert.equal(cl.cueAt(cues, 55).text, 'standby lights')
assert.equal(cl.cueAfter(cues, 46).text, 'standby lights')
assert.equal(cl.cueAfter(cues, 5).text, 'GO')
// search
assert.equal(cl.findCue(cues, '1').time, 45) // numeric match on CUE 1.00
assert.equal(cl.findCue(cues, '2').time, 60)
assert.equal(cl.findCue(cues, 'act one').time, 30) // section name, case-insensitive
assert.equal(cl.findCue(cues, 'standby'), undefined)
assert.equal(cl.findCue(cues, 'standby', { match: 'starts' }).time, 50)
assert.equal(cl.findCue(cues, 'lights', { match: 'contains' }).time, 50)
assert.equal(cl.findCue(cues, '3', { kind: 'section' }).time, 60)
assert.equal(cl.findCue(cues, 'GO', { kind: 'tag' }).time, 12)
assert.equal(cl.findCue(cues, 'GO', { kind: 'note' }), undefined)
assert.equal(cl.findCue(cues, 'GO', { kind: 'tag:MIDI' }).time, 12)
assert.equal(cl.findCue(cues, 'GO', { kind: 'tag:CUE' }), undefined)
assert.equal(cl.findCue(cues, '1', { kind: 'tag:CUE' }).time, 45)
assert.equal(cl.findCue(cues, ''), undefined)

console.log('logic tests passed')
