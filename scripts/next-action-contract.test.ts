import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `nextAction` is the machine-readable recovery step. The repository builds
 * with Bun, which strips types without checking them, so the constructor's
 * required parameter documents the contract rather than enforcing it. These
 * assertions are the enforcement.
 */
const files = ["claude-development-installation.ts", "dev.ts"].map((name) => ({
	name,
	source: readFileSync(join(import.meta.dir, name), "utf8"),
}))

interface Construction {
	file: string
	code: string
	body: string
}

/**
 * Match every construction, including the helper sites whose first argument is
 * `options.code` rather than a literal. A scan that only saw literals is how
 * nine helper-fed sites stayed silent through an earlier audit.
 */
function constructions(): Construction[] {
	const found: Construction[] = []
	for (const { name, source } of files) {
		const pattern = /new ClaudeDevelopmentInstallationError\(\s*([^,]+),([\s\S]*?)\n\t*\)/g
		let match = pattern.exec(source)
		while (match) {
			found.push({
				file: name,
				code: (match[1] as string).trim().replace(/^"|"$/g, ""),
				body: match[2] as string,
			})
			match = pattern.exec(source)
		}
	}
	return found
}

test("every error construction states a recovery step", () => {
	const silent = constructions()
		.filter((entry) => !entry.body.includes("nextAction"))
		.map((entry) => `${entry.file}:${entry.code}`)

	expect(silent).toEqual([])
})

test("the scan reaches both literal and helper-fed constructions", () => {
	const all = constructions()
	// A scan that matched nothing would satisfy every other assertion here.
	expect(all.length).toBeGreaterThanOrEqual(28)
	expect(all.some((entry) => entry.code === "options.code")).toBe(true)
	expect(all.some((entry) => entry.code === "DEVELOPMENT_CACHE_ORPHANED")).toBe(true)
	expect(all.some((entry) => entry.file === "dev.ts")).toBe(true)
})

test("no recovery step is a bare rerun of the command that failed", () => {
	// Naming `check` after a repair step is a precondition, not a loop. Naming
	// it as the whole recovery is the defect: the caller repeats the failure.
	const looping = constructions()
		.filter((entry) =>
			/nextAction:\s*\n?\s*[`"]Run\s+\\?`?bun run dev -- claude check/.test(entry.body),
		)
		.map((entry) => `${entry.file}:${entry.code}`)

	expect(looping).toEqual([])
})

test("no object declares the recovery step twice", () => {
	// A duplicate key is legal JavaScript and the last one silently wins, so a
	// stale value can outlive the edit that was meant to replace it.
	for (const { name, source } of files) {
		const duplicates: string[] = []
		const openedAt: number[] = []
		const counts: number[] = []
		source.split("\n").forEach((text, index) => {
			for (const character of text) {
				if (character === "{") {
					openedAt.push(index + 1)
					counts.push(0)
				} else if (character === "}") {
					const count = counts.pop()
					const opened = openedAt.pop()
					if (count !== undefined && count > 1) duplicates.push(`${name}:${opened}`)
				}
			}
			if (/^\s*nextAction\s*:/.test(text) && counts.length > 0) {
				counts[counts.length - 1] = (counts[counts.length - 1] as number) + 1
			}
		})
		expect(duplicates).toEqual([])
	}
})

test("the constructor keeps no default recovery step to inherit", () => {
	for (const { source } of files) {
		expect(source).not.toMatch(/nextAction\s*=\s*options\.nextAction\s*\?\?/)
		expect(source).not.toMatch(/nextAction\?\s*:/)
	}
})
