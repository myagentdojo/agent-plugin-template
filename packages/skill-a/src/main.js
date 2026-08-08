// ESM-authored skill A. Proves an ESM entry importing one ESM-only dependency
// (camelcase) and one CJS dependency (ms) through Bun's ESM/CJS interop.
import camelcase from "camelcase"
import ms from "ms"

/**
 * Build the dependency-boundary proof emitted by skill A.
 *
 * @returns {{skill: string, moduleShape: string, esmDependency: string, cjsDependencyMilliseconds: number, sideEffects: string}} One JSON-serializable proof object
 *
 * @example
 * ```js
 * skillAProof().esmDependency // "skillAOfflineProof"
 * ```
 */
export function skillAProof() {
	return {
		skill: "skill-a",
		moduleShape: "esm",
		esmDependency: camelcase("skill a offline proof"),
		cjsDependencyMilliseconds: ms("2h"),
		sideEffects: "none",
	}
}

console.log(JSON.stringify(skillAProof()))
