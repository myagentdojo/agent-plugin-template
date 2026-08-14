import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, test } from "bun:test"

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const workflowPaths = [
	".github/workflows/plugin-ci.yml",
	".github/workflows/hosted-canary.yml",
	".github/workflows/release.yml",
] as const

function workflowSources(): string[] {
	return workflowPaths.map((path) => readFileSync(`${root}/${path}`, "utf8"))
}

function extractPinLine(workflow: string): string {
	const matches = workflow
		.split("\n")
		.filter((line) => line.trimStart().startsWith("run: bun add --global "))
	if (matches.length !== 1) {
		throw new Error(`expected one native CLI pin line, found ${matches.length}`)
	}
	return matches[0]
}

function expectWorkflowPinParity(workflows: string[]): void {
	const pinLines = workflows.map(extractPinLine)
	expect(pinLines).toEqual(Array.from({ length: pinLines.length }, () => pinLines[0]))
}

function bumpPinnedVersions(workflow: string): string {
	const pinLine = extractPinLine(workflow)
	const bumpedPinLine = pinLine.replace(
		/@(\d+)\.(\d+)\.(\d+)(?=")/g,
		(_, major, minor, patch) => `@${major}.${minor}.${Number(patch) + 1}`,
	)
	if (bumpedPinLine === pinLine) {
		throw new Error("native CLI pin line contains no semantic versions")
	}
	return workflow.replace(pinLine, bumpedPinLine)
}

test("native CLI workflow pin lines are byte-identical", () => {
	expectWorkflowPinParity(workflowSources())
})

test("workflow pin parity rejects one differing line and accepts a coordinated bump", () => {
	const workflows = workflowSources()
	const oneDiffering = [...workflows]
	oneDiffering[0] = bumpPinnedVersions(oneDiffering[0])

	expect(() => expectWorkflowPinParity(oneDiffering)).toThrow()
	expectWorkflowPinParity(workflows.map(bumpPinnedVersions))
})
