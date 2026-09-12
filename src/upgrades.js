/**
 * @file Config/action/feedback upgrade scripts.
 *
 * Companion runs these in order when a connection created with an older module version is loaded.
 * Append new scripts at the end and never remove existing ones – Companion stores the index of the
 * last script that ran.
 * @type {import('@companion-module/base').CompanionStaticUpgradeScript<any>[]}
 */
const UpgradeScripts = [
	// 1.0.0: the Live Update interval, session refresh, timecode frame rate and debug options became fixed defaults
	function removeFixedOptions(_context, props) {
		/** @type {{updatedConfig: Record<string, unknown>|null, updatedActions: never[], updatedFeedbacks: never[]}} */
		const result = { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		if (props.config) {
			const config = { ...props.config }
			let changed = false
			for (const key of ['updateMs', 'pollSeconds', 'fps', 'debug']) {
				if (key in config) {
					delete config[key]
					changed = true
				}
			}
			if (changed) result.updatedConfig = config
		}
		return result
	},
]

module.exports = { UpgradeScripts }
