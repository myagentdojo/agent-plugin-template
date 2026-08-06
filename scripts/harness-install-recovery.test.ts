import { expect, test } from "bun:test"

import {
	assertExactHarnessRecovery,
	provePostMutationRecovery,
	type HarnessRecoverySnapshot,
} from "./harness-install-recovery"

const prior: HarnessRecoverySnapshot = {
	source: "/detached/v0.1.0",
	ref: "v0.1.0",
	version: "0.1.0",
	payloadInventory: ["plugin.json", "runtime/hello-world.js"],
	enabled: false,
	scope: "project",
	persistentData: "project marker\n",
}

test("post-mutation failure enters the recovery handler and returns its restored value", () => {
	const phases: string[] = []
	const result = provePostMutationRecovery(prior, {
		harness: "Claude",
		mutate: () => phases.push("removed"),
		restore: () => {
			phases.push("restored")
			return { value: "recovered", snapshot: structuredClone(prior) }
		},
	})

	expect(result).toBe("recovered")
	expect(phases).toEqual(["removed", "restored"])
})

test("unexpected mutation failure does not masquerade as the injected recovery path", () => {
	let restored = false
	expect(() =>
		provePostMutationRecovery(prior, {
			harness: "Claude",
			mutate: () => {
				throw new Error("real removal failure")
			},
			restore: () => {
				restored = true
				return { value: "recovered", snapshot: structuredClone(prior) }
			},
		}),
	).toThrow("real removal failure")
	expect(restored).toBe(false)
})

test.each([
	["source", "/wrong/source"],
	["ref", "v9.9.9"],
	["version", "9.9.9"],
	["payloadInventory", ["plugin.json"]],
	["enabled", true],
	["scope", "user"],
	["persistentData", "changed\n"],
] as const)("exact recovery rejects mismatched %s", (field, value) => {
	expect(() =>
		provePostMutationRecovery(prior, {
			harness: "Claude",
			mutate: () => {},
			restore: () => ({ value: "restored", snapshot: { ...prior, [field]: value } }),
		}),
	).toThrow(`Claude recovery did not restore prior ${field}`)
})

test("exact recovery accepts an identical captured snapshot", () => {
	expect(() => assertExactHarnessRecovery(prior, structuredClone(prior), "Claude")).not.toThrow()
})
