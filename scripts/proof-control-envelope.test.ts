import { describe, expect, test } from "bun:test"
import { requireProofControlEnvelope } from "./proof-control-envelope"

function result(stdout: string): ReturnType<typeof Bun.spawnSync> {
	return {
		exitCode: 0,
		stdout: Buffer.from(`${stdout}\n`),
		stderr: Buffer.from(""),
	} as ReturnType<typeof Bun.spawnSync>
}

const valid = {
	schemaVersion: 1,
	ok: true,
	code: "REPAIR_APPLIED",
	sideEffects: ["runtime cache updated"],
	retrySafe: true,
	nextAction: "Retry the skill launcher.",
	runtime: { version: "1.3.14", executableSha256: "a".repeat(64) },
}

test("accepts a complete runtime control envelope", () => {
	expect(requireProofControlEnvelope("repair", result(JSON.stringify(valid)), 0, valid.code)).toEqual(valid)
})

describe("rejects malformed runtime control envelope fields", () => {
	test.each([
		["non-object", null],
		["ok", { ...valid, ok: "true" }],
		["sideEffects container", { ...valid, sideEffects: "runtime cache updated" }],
		["sideEffects member", { ...valid, sideEffects: [1] }],
		["retrySafe", { ...valid, retrySafe: "true" }],
		["nextAction", { ...valid, nextAction: ["retry"] }],
		["runtime null", { ...valid, runtime: null }],
		["runtime array", { ...valid, runtime: [] }],
		["runtime version", { ...valid, runtime: { version: 1 } }],
		["runtime digest", { ...valid, runtime: { executableSha256: false } }],
	] as const)("rejects %s", (_name, envelope) => {
		expect(() => requireProofControlEnvelope("repair", result(JSON.stringify(envelope)), 0, valid.code)).toThrow(
			/repair: (expected one JSON control object|invalid REPAIR_APPLIED control object)/,
		)
	})
})

test("wraps malformed JSON with proof-step context", () => {
	expect(() => requireProofControlEnvelope("repair", result("{"), 0, valid.code)).toThrow(
		"repair: expected one JSON control object",
	)
})
