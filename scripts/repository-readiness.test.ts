import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
	REQUIRED_STATUS_CHECKS,
	classifyActionsPermissions,
	classifyApiFailure,
	classifyRepositorySettings,
	classifyRequiredStatusChecks,
	classifyTagRuleset,
	classifyWorkflowAdminPermissions,
	summarizeReadiness,
} from "./repository-readiness"

const root = resolve(import.meta.dir, "..")
const tagRulesetRepair =
	"Settings > Rules > Rulesets > New tag ruleset: target tags matching v*, enable Restrict deletions and Restrict updates, no bypass actors"

function immutableTagRuleset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 17,
		name: "Immutable version tags",
		target: "tag",
		enforcement: "active",
		bypass_actors: [],
		conditions: {
			ref_name: {
				include: ["refs/tags/v*"],
				exclude: [],
			},
		},
		rules: [{ type: "deletion" }, { type: "update" }],
		...overrides,
	}
}

test("reports ready when every publication safeguard is proven", () => {
	const checks = [
		classifyTagRuleset([immutableTagRuleset()]),
		...classifyRepositorySettings({ default_branch: "main", allow_merge_commit: true }),
		classifyActionsPermissions({ enabled: true, allowed_actions: "all" }),
		classifyRequiredStatusChecks({ strict: true, contexts: REQUIRED_STATUS_CHECKS }),
		classifyWorkflowAdminPermissions([
			{
				path: ".github/workflows/release.yml",
				source: "permissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n",
			},
		]),
	]

	expect(summarizeReadiness(checks)).toEqual({ ok: true, checks })
	expect(checks.every((check) => check.status === "ready")).toBe(true)
})

describe("immutable version tag ruleset", () => {
	test.each([
		["absent", []],
		["disabled", [immutableTagRuleset({ enforcement: "disabled" })]],
		[
			"bypassable",
			[
				immutableTagRuleset({
					bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
				}),
			],
		],
		["mutable", [immutableTagRuleset({ rules: [{ type: "deletion" }] })]],
	] as const)("reports the settings repair when the rule is %s", (_condition, rulesets) => {
		const check = classifyTagRuleset(rulesets)

		expect(check.status).toBe("missing")
		expect(check.repair).toBe(tagRulesetRepair)
		expect(check.detail).toContain("immutable")
	})
})

test("fails closed distinctly when a safeguard API is missing, unauthorized, or unavailable", () => {
	const repair = "Settings > Rules > Rulesets: verify the immutable v* tag ruleset"
	const missingByStatus = classifyApiFailure("tag-ruleset", 404, "HTTP 404", repair)
	const missingByMessage = classifyApiFailure("tag-ruleset", 1, "resource not found", repair)
	const unauthorized401 = classifyApiFailure("tag-ruleset", 401, "HTTP 401", repair)
	const unauthorized = classifyApiFailure("tag-ruleset", 403, "HTTP 403: Resource not accessible", repair)
	const unavailable = classifyApiFailure("tag-ruleset", 1, "network unreachable", repair)

	expect(missingByStatus).toMatchObject({ status: "missing", repair })
	expect(missingByMessage).toMatchObject({ status: "missing", repair })
	expect(unauthorized401).toMatchObject({ status: "unauthorized", repair })
	expect(unauthorized).toMatchObject({ status: "unauthorized", repair })
	expect(unavailable).toMatchObject({ status: "unavailable", repair })
	expect(summarizeReadiness([missingByStatus]).ok).toBe(false)
	expect(summarizeReadiness([unauthorized]).ok).toBe(false)
	expect(summarizeReadiness([unavailable]).ok).toBe(false)
})

test("workflow repository-administration permission fails the local safeguard", () => {
	const check = classifyWorkflowAdminPermissions([
		{
			path: ".github/workflows/release.yml",
			source: "jobs:\n  publish:\n    permissions:\n      contents: write\n      administration: write\n",
		},
	])

	expect(check).toMatchObject({
		status: "missing",
		repair:
			"Remove administration from workflow permissions; release publication needs contents: write, never repository administration",
	})
	expect(check.detail).toContain(".github/workflows/release.yml")
})

test("real repository workflows grant no repository-administration permission", () => {
	const workflowDirectory = join(root, ".github", "workflows")
	const workflows = readdirSync(workflowDirectory)
		.filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))
		.map((path) => ({
			path: `.github/workflows/${path}`,
			source: readFileSync(join(workflowDirectory, path), "utf8"),
		}))

	expect(classifyWorkflowAdminPermissions(workflows)).toMatchObject({ status: "ready" })
})

test("missing release-path status checks name the branch settings repair", () => {
	const check = classifyRequiredStatusChecks({ contexts: ["Release impact"] })

	expect(check.status).toBe("missing")
	expect(check.detail).toContain("Deterministic package")
	expect(check.repair).toContain("Settings > Branches > Branch protection rules")
})
