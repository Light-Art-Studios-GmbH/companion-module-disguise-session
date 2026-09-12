/**
 * @file Keyframable layer properties offered by the module.
 *
 * One entry per property the "keyframe fade" / "clear keyframes" actions can address. `field` is the Designer
 * field name (as in the layer editor / Layer.findSequence), min/max are the value range the presets use.
 * Add further properties here; actions, presets and the instance pick them up automatically.
 */
const LAYER_PROPERTIES = {
	// disguise documents Brightness as the layer's alpha/opacity control (blend mode Alpha: 0 = transparent)
	opacity: { label: 'Opacity', field: 'brightness', min: 0, max: 1 },
}

/** Dropdown choices for the actions. */
function propertyChoices() {
	return Object.entries(LAYER_PROPERTIES).map(([id, p]) => ({ id, label: p.label }))
}

/** @param {unknown} id */
function propertyOf(id) {
	return LAYER_PROPERTIES[String(id ?? '').trim()] || LAYER_PROPERTIES.opacity
}

module.exports = { LAYER_PROPERTIES, propertyChoices, propertyOf }
