/**
 * @file Module entrypoint.
 *
 * Companion (module API 2.x) imports this file and expects the connection class as default export and
 * an `UpgradeScripts` named export. The entry is an ES module so that both the developer-folder load and
 * the esbuild bundle produced by `companion-module-build` expose the named export; the implementation is
 * CommonJS.
 */
import { DisguiseInstance } from './instance.js'
import { UpgradeScripts } from './upgrades.js'

export default DisguiseInstance
export { UpgradeScripts }
