import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
	REQUIRED_STATUS_CHECKS,
	actionReferencesFromWorkflows,
	classifyActionsPermissions,
	classifyApiFailure,
	classifyMergeHistoryPolicy,
	classifyRepositorySettings,
	classifyReleaseAutomationConfiguration,
	classifyReleaseEnvironmentProtection,
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
		classifyMergeHistoryPolicy(null, [{ type: "required_status_checks" }]),
		...classifyRepositorySettings({ default_branch: "main", allow_merge_commit: true }),
		classifyActionsPermissions({ enabled: true, allowed_actions: "all" }),
		classifyReleaseAutomationConfiguration(
			{ secrets: [{ name: "RELEASE_PLEASE_TOKEN" }] },
			{ variables: [{ name: "RELEASE_PLEASE_AUTOMATION_LOGIN", value: "must-not-leak" }] },
		),
		classifyReleaseEnvironmentProtection({
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "release-owner" } }] },
			],
		}),
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

describe("main merge-history policy", () => {
	test("accepts absent classic protection and effective rules without linear history", () => {
		expect(classifyMergeHistoryPolicy(null, [{ type: "required_status_checks" }])).toMatchObject({
			name: "merge-history-policy",
			status: "ready",
			repair: "",
		})
	})

	test("rejects classic branch protection requiring linear history", () => {
		expect(
			classifyMergeHistoryPolicy(
				{ required_linear_history: { enabled: true } },
				[{ type: "required_status_checks" }],
			),
		).toMatchObject({ status: "missing" })
	})

	test("rejects an effective ruleset requiring linear history", () => {
		expect(
			classifyMergeHistoryPolicy(null, [{ type: "required_linear_history" }]),
		).toMatchObject({ status: "missing" })
	})

	test("accepts explicitly disabled classic linear-history protection", () => {
		expect(
			classifyMergeHistoryPolicy(
				{ required_linear_history: { enabled: false } },
				[{ type: "pull_request" }],
			),
		).toMatchObject({ status: "ready" })
	})

	test.each([
		["classic protection", undefined, []],
		["classic linear-history rule", { required_linear_history: {} }, []],
		["effective rules", null, undefined],
		["malformed effective rule", null, [{}]],
	] as const)("fails closed for unreadable %s", (_condition, protection, rules) => {
		expect(classifyMergeHistoryPolicy(protection, rules)).toMatchObject({
			name: "merge-history-policy",
			status: "unavailable",
		})
	})
})

describe("release environment required reviewers", () => {
	const repair =
		"Settings > Environments > release > Deployment protection rules: enable Required reviewers and add at least one reviewer"

	test("accepts configured required-reviewer protection", () => {
		expect(
			classifyReleaseEnvironmentProtection({
				protection_rules: [
					{ type: "required_reviewers", reviewers: [{ type: "Team", reviewer: { slug: "releasers" } }] },
				],
			}),
		).toMatchObject({ name: "release-environment-reviewers", status: "ready", repair: "" })
	})

	test.each([
		["missing rule", { protection_rules: [] }, "missing"],
		["empty reviewer list", { protection_rules: [{ type: "required_reviewers", reviewers: [] }] }, "missing"],
		["unreadable response", undefined, "unavailable"],
	] as const)("fails closed for %s", (_condition, response, status) => {
		expect(classifyReleaseEnvironmentProtection(response)).toMatchObject({
			name: "release-environment-reviewers",
			status,
			repair,
		})
	})
})

test("release automation readiness checks names without exposing values", () => {
	const readyCheck = classifyReleaseAutomationConfiguration(
		{ secrets: [{ name: "RELEASE_PLEASE_TOKEN" }] },
		{ variables: [{ name: "RELEASE_PLEASE_AUTOMATION_LOGIN", value: "myagentdojo" }] },
	)
	const missingCheck = classifyReleaseAutomationConfiguration({ secrets: [] }, { variables: [] })

	expect(readyCheck).toMatchObject({ status: "ready" })
	expect(JSON.stringify(readyCheck)).not.toContain("myagentdojo")
	expect(missingCheck).toMatchObject({ status: "missing" })
	expect(missingCheck.detail).toContain("secret RELEASE_PLEASE_TOKEN")
	expect(missingCheck.detail).toContain("variable RELEASE_PLEASE_AUTOMATION_LOGIN")
})

describe("Actions permissions", () => {
	const requiredActions = [
		"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
		"actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
		"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
		"googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
	]

	test.each([
		["unreadable response", undefined, "unavailable"],
		["disabled Actions", { enabled: false, allowed_actions: "all" }, "missing"],
		["unreadable policy", { enabled: true }, "unavailable"],
	] as const)("fails closed for %s", (_condition, permissions, status) => {
		expect(classifyActionsPermissions(permissions, undefined, requiredActions)).toMatchObject({
			status,
		})
	})

	test("rejects local-only policy", () => {
		expect(
			classifyActionsPermissions(
				{ enabled: true, allowed_actions: "local_only" },
				undefined,
				requiredActions,
			),
		).toMatchObject({ status: "missing" })
	})

	test("accepts selected GitHub-owned and verified actions", () => {
		expect(
			classifyActionsPermissions(
				{ enabled: true, allowed_actions: "selected" },
				{ github_owned_allowed: true, verified_allowed: true, patterns_allowed: [] },
				requiredActions,
			),
		).toMatchObject({ status: "ready" })
	})

	test("accepts selected action patterns pinned to exact refs", () => {
		expect(
			classifyActionsPermissions(
				{ enabled: true, allowed_actions: "selected" },
				{
					github_owned_allowed: true,
					verified_allowed: false,
					patterns_allowed: ["oven-sh/setup-bun@*", "googleapis/release-please-action@*"],
				},
				requiredActions,
			),
		).toMatchObject({ status: "ready" })
	})

	test("rejects a selected policy that omits a required action", () => {
		const check = classifyActionsPermissions(
			{ enabled: true, allowed_actions: "selected" },
			{
				github_owned_allowed: true,
				verified_allowed: false,
				patterns_allowed: ["oven-sh/setup-bun@*"],
			},
			requiredActions,
		)

		expect(check).toMatchObject({ status: "missing" })
		expect(check.detail).toContain("googleapis/release-please-action@")
	})

	test("fails closed when selected-action settings are unreadable", () => {
		expect(
			classifyActionsPermissions(
				{ enabled: true, allowed_actions: "selected" },
				undefined,
				requiredActions,
			),
		).toMatchObject({ status: "unavailable" })
	})

	test("discovers both list-item and job-level action references", () => {
		expect(
			actionReferencesFromWorkflows([
				"steps:\n  - uses: oven-sh/setup-bun@pinned\njob:\n  uses: actions/example@pinned\n  - uses: ./local\n",
			]),
		).toEqual(["actions/example@pinned", "oven-sh/setup-bun@pinned"])
	})

	test("real workflows include the pinned setup-bun action", () => {
		const workflowDirectory = join(root, ".github", "workflows")
		const references = actionReferencesFromWorkflows(
			readdirSync(workflowDirectory)
				.filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))
				.map((path) => readFileSync(join(workflowDirectory, path), "utf8")),
		)

		expect(references).toContain(
			"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
		)
	})
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
		[
			"non-fast-forward only",
			[
				immutableTagRuleset({
					rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
				}),
			],
		],
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
