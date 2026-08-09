// CJS-authored skill B. Proves a CJS entry requiring one classic CJS
// dependency (ms) plus one conditional-export boundary: kleur ships dual
// CJS/ESM builds selected through its package.json "exports" map, and this
// require() must resolve the "require" condition.
"use strict"

const kleur = require("kleur")
const ms = require("ms")

kleur.enabled = true

/**
 * Build the dependency-boundary proof emitted by skill B.
 *
 * @returns {{skill: string, moduleShape: string, cjsDependencyDuration: string, conditionalExportDependency: string, sideEffects: string}} One JSON-serializable proof object
 *
 * @example
 * ```js
 * skillBProof().cjsDependencyDuration // "2 hours"
 * ```
 */
function skillBProof() {
	return {
		skill: "skill-b",
		moduleShape: "cjs",
		cjsDependencyDuration: ms(7_200_000, { long: true }),
		conditionalExportDependency: kleur.green("conditional-export-proof"),
		sideEffects: "none",
	}
}

module.exports = { skillBProof }

console.log(JSON.stringify(skillBProof()))
