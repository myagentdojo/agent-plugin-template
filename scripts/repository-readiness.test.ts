import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
	REQUIRED_HOSTED_CANARY_SECRETS,
	REQUIRED_STATUS_CHECKS,
	actionReferencesFromWorkflows,
	classifyActionsPermissions,
	classifyApiFailure,
	classifyDirectPushProtection,
	classifyHostedCanaryConfiguration,
	readRepositoryVariable,
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

test("public readiness process reaches the configured hosted-canary success path", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "repository-readiness-process-"))
	const fakeGhPath = join(fixtureRoot, "gh")
	const repository = "myagentdojo/my-second-brain"
	const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICanary"
	const responses: Record<string, unknown> = {
		[`repos/${repository}`]: {
			default_branch: "main",
			allow_squash_merge: true,
			allow_merge_commit: true,
		},
		[`repos/${repository}/rulesets?includes_parents=true&per_page=100`]: [
			[
				{ id: 17, target: "tag" },
				{ id: 18, target: "branch" },
			],
		],
		[`repos/${repository}/rulesets/17?includes_parents=true`]: {
			id: 17,
			name: "Immutable version tags",
			target: "tag",
			enforcement: "active",
			bypass_actors: [],
			conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
			rules: [{ type: "deletion" }, { type: "update" }],
		},
		[`repos/${repository}/rulesets/18?includes_parents=true`]: {
			id: 18,
			name: "Protected main",
			target: "branch",
			enforcement: "active",
			bypass_actors: [],
			conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
			rules: [{ type: "pull_request" }, { type: "non_fast_forward" }],
		},
		[`repos/${repository}/branches/main/protection`]: {},
		[`repos/${repository}/rules/branches/main`]: [{ type: "required_status_checks" }],
		[`repos/${repository}/actions/permissions`]: { enabled: true, allowed_actions: "all" },
		[`repos/${repository}/actions/secrets`]: {
			secrets: [{ name: "RELEASE_PLEASE_TOKEN" }],
		},
		[`repos/${repository}/actions/variables`]: {
			variables: [{ name: "RELEASE_PLEASE_AUTOMATION_LOGIN", value: "myagentdojo" }],
		},
		[`repos/${repository}/branches/main/protection/required_status_checks`]: {
			contexts: REQUIRED_STATUS_CHECKS,
		},
		[`repos/${repository}/environments/release`]: {
			protection_rules: [
				{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "owner" } }] },
			],
		},
		[`repos/${repository}/environments/hosted-canary-qualification`]: {
			name: "hosted-canary-qualification",
		},
		[`repos/${repository}/environments/hosted-canary-qualification/secrets`]: {
			secrets: REQUIRED_HOSTED_CANARY_SECRETS.map((name) => ({ name })),
		},
		"users/myagentdojo/keys?per_page=100": [[{ key: publicKey }]],
		[`repos/${repository}/actions/variables?per_page=100`]: [
			{ variables: [{ name: "CANARY_SSH_PUBLIC_KEY", value: publicKey }] },
		],
	}
	const fakeGhSource = `#!/usr/bin/env bun
const responses = ${JSON.stringify(responses)}
const endpoint = process.argv.at(-1)
if (typeof endpoint !== "string" || !Object.hasOwn(responses, endpoint)) {
  console.error(\`unexpected gh endpoint: \${String(endpoint)}\`)
  process.exit(1)
}
console.log(JSON.stringify(responses[endpoint]))
`

	try {
		writeFileSync(fakeGhPath, fakeGhSource, { mode: 0o755 })
		chmodSync(fakeGhPath, 0o755)
		const environment = {
			...process.env,
			PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
		}
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"run",
				"scripts/repository-readiness.ts",
				"--repo",
				repository,
				"--json",
			],
			cwd: root,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(0)
		expect(result.stderr.toString()).toBe("")
		const output = JSON.parse(result.stdout.toString())
		expect(output).toMatchObject({ ok: true, repository, sideEffects: "none" })
		expect(output.checks.every((check: { status?: string }) => check.status === "ready")).toBe(true)
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true })
	}
})

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

function reviewedDefaultBranchRuleset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 18,
		name: "Require pull requests for main",
		target: "branch",
		enforcement: "active",
		bypass_actors: [],
		conditions: {
			ref_name: {
				include: ["~DEFAULT_BRANCH"],
				exclude: [],
			},
		},
		rules: [{ type: "pull_request" }, { type: "non_fast_forward" }],
		...overrides,
	}
}

test("reports ready when every publication safeguard is proven", () => {
	const checks = [
		classifyTagRuleset([immutableTagRuleset()]),
		classifyDirectPushProtection([reviewedDefaultBranchRuleset()], "main"),
		classifyMergeHistoryPolicy(null, [{ type: "required_status_checks" }], true),
		...classifyRepositorySettings({
			default_branch: "main",
			allow_squash_merge: true,
			allow_merge_commit: false,
		}),
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
		classifyHostedCanaryConfiguration(
			{ name: "hosted-canary-qualification" },
			{ secrets: REQUIRED_HOSTED_CANARY_SECRETS.map((name) => ({ name })) },
			{
				registeredPublicKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICanary"],
				expectedPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICanary",
				actor: "myagentdojo",
				registrationComplete: true,
			},
		),
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

describe("default branch direct-push protection", () => {
	test("accepts an active no-bypass pull-request and force-push-blocking ruleset targeting the default branch", () => {
		expect(classifyDirectPushProtection([reviewedDefaultBranchRuleset()], "main")).toMatchObject({
			name: "direct-push-protection",
			status: "ready",
			repair: "",
		})
	})

	test.each([
		["all branches", ["~ALL"]],
		["bare default branch", ["main"]],
		["full default branch ref", ["refs/heads/main"]],
		["single-segment branch wildcard", ["refs/heads/*"]],
		["recursive branch wildcard", ["refs/heads/**"]],
	] as const)("accepts %s targeting", (_description, include) => {
		expect(
			classifyDirectPushProtection(
				[reviewedDefaultBranchRuleset({ conditions: { ref_name: { include, exclude: [] } } })],
				"main",
			),
		).toMatchObject({ status: "ready" })
	})

	test.each([
		["absent", []],
		["disabled", [reviewedDefaultBranchRuleset({ enforcement: "disabled" })]],
		[
			"bypassable",
			[
				reviewedDefaultBranchRuleset({
					bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
				}),
			],
		],
		[
			"non-default branch",
			[reviewedDefaultBranchRuleset({ conditions: { ref_name: { include: ["release"], exclude: [] } } })],
		],
		[
			"excluded default branch",
			[reviewedDefaultBranchRuleset({ conditions: { ref_name: { include: ["~ALL"], exclude: ["main"] } } })],
		],
		[
			"wildcard-excluded default branch",
			[reviewedDefaultBranchRuleset({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/*"] } } })],
		],
		[
			"without pull-request rule",
			[reviewedDefaultBranchRuleset({ rules: [{ type: "non_fast_forward" }] })],
		],
		[
			"without force-push block",
			[reviewedDefaultBranchRuleset({ rules: [{ type: "pull_request" }] })],
		],
	] as const)("reports the settings repair when the ruleset is %s", (_condition, rulesets) => {
		const check = classifyDirectPushProtection(rulesets, "main")

		expect(check).toMatchObject({ status: "missing" })
		expect(check.repair).toContain("Block force pushes")
	})

	test.each([
		["ruleset response", undefined, "main"],
		["empty default branch", [reviewedDefaultBranchRuleset()], ""],
		["ruleset", [{}], "main"],
		["non-record ruleset", ["not-a-ruleset"], "main"],
		["bypass actors", [reviewedDefaultBranchRuleset({ bypass_actors: {} })], "main"],
		["conditions", [reviewedDefaultBranchRuleset({ conditions: {} })], "main"],
		["rule", [reviewedDefaultBranchRuleset({ rules: [{}] })], "main"],
	] as const)("fails closed for unreadable %s", (_condition, rulesets, defaultBranch) => {
		expect(classifyDirectPushProtection(rulesets, defaultBranch)).toMatchObject({
			name: "direct-push-protection",
			status: "unavailable",
		})
	})

	test("skips well-formed non-branch rulesets", () => {
		expect(
			classifyDirectPushProtection([immutableTagRuleset(), reviewedDefaultBranchRuleset()], "main"),
		).toMatchObject({ status: "ready" })
	})
})

describe("release merge methods", () => {
	test("accepts squash-only repositories", () => {
		expect(
			classifyRepositorySettings({
				default_branch: "main",
				allow_squash_merge: true,
				allow_merge_commit: false,
			}),
		).toContainEqual(expect.objectContaining({ name: "squash-merge", status: "ready", repair: "" }))
	})

	test("rejects merge-commit-only repositories because ordinary pull requests must remain squashable", () => {
		expect(
			classifyRepositorySettings({
				default_branch: "main",
				allow_squash_merge: false,
				allow_merge_commit: true,
			}),
		).toContainEqual(
			expect.objectContaining({
				name: "squash-merge",
				status: "missing",
				repair: expect.stringContaining("Allow squash merging"),
			}),
		)
	})

	test("rejects repositories without squash merging", () => {
		const check = classifyRepositorySettings({
			default_branch: "main",
			allow_squash_merge: false,
			allow_merge_commit: false,
		}).find(({ name }) => name === "squash-merge")

		expect(check).toMatchObject({ name: "squash-merge", status: "missing" })
		expect(check?.repair).toContain("Allow squash merging")
	})

	test.each([
		["missing squash setting", { default_branch: "main", allow_merge_commit: true }],
		[
			"non-boolean setting",
			{ default_branch: "main", allow_squash_merge: "yes", allow_merge_commit: false },
		],
	] as const)("fails closed for %s", (_condition, repository) => {
		expect(classifyRepositorySettings(repository)).toContainEqual(
			expect.objectContaining({ name: "squash-merge", status: "unavailable" }),
		)
	})
})

describe("main merge-history policy", () => {
	test("accepts absent classic protection and effective rules without linear history", () => {
		expect(classifyMergeHistoryPolicy(null, [{ type: "required_status_checks" }], false)).toMatchObject({
			name: "merge-history-policy",
			status: "ready",
			repair: "",
		})
	})

	test("accepts classic branch protection requiring linear history when squash is enabled", () => {
		expect(
			classifyMergeHistoryPolicy(
				{ required_linear_history: { enabled: true } },
				[{ type: "required_status_checks" }],
				true,
			),
		).toMatchObject({ status: "ready", repair: "" })
	})

	test("accepts an effective ruleset requiring linear history when squash is enabled", () => {
		expect(
			classifyMergeHistoryPolicy(null, [{ type: "required_linear_history" }], true),
		).toMatchObject({ status: "ready", repair: "" })
	})

	test("rejects required linear history when only merge commits are enabled", () => {
		const check = classifyMergeHistoryPolicy(null, [{ type: "required_linear_history" }], false)

		expect(check).toMatchObject({ status: "missing" })
		expect(check.repair).toContain("Allow squash merging")
	})

	test("accepts explicitly disabled classic linear-history protection", () => {
		expect(
			classifyMergeHistoryPolicy(
				{ required_linear_history: { enabled: false } },
				[{ type: "pull_request" }],
				false,
			),
		).toMatchObject({ status: "ready" })
	})

	test.each([
		["classic protection", undefined, []],
		["classic linear-history rule", { required_linear_history: {} }, []],
		["effective rules", null, undefined],
		["malformed effective rule", null, [{}]],
		["malformed effective rule with classic linear history", { required_linear_history: { enabled: true } }, [{}]],
	] as const)("fails closed for unreadable %s", (_condition, protection, rules) => {
		expect(classifyMergeHistoryPolicy(protection, rules, true)).toMatchObject({
			name: "merge-history-policy",
			status: "unavailable",
		})
	})

	test("fails closed when squash capability is unreadable", () => {
		expect(classifyMergeHistoryPolicy(null, [], undefined)).toMatchObject({
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

describe("hosted-canary qualification configuration", () => {
	const environment = { name: "hosted-canary-qualification" }
	const secrets = { secrets: REQUIRED_HOSTED_CANARY_SECRETS.map((name) => ({ name })) }
	const canaryPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICanary"
	const otherPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUnrelated"
	const canaryKey = {
		registeredPublicKeys: [canaryPublicKey],
		expectedPublicKey: canaryPublicKey,
		actor: "myagentdojo",
		registrationComplete: true,
	}

	test("accepts the environment with all required secret names", () => {
		expect(
			classifyHostedCanaryConfiguration(environment, secrets, canaryKey),
		).toMatchObject({
			name: "hosted-canary-configuration",
			status: "ready",
			repair: "",
		})
	})

	test("reports every absent environment secret without reading values", () => {
		const check = classifyHostedCanaryConfiguration(environment, {
			secrets: [{ name: "UNRELATED_SECRET", value: "must-not-leak" }],
		})

		expect(check).toMatchObject({ status: "missing" })
		expect(check.detail).toContain("CANARY_GH_TOKEN")
		expect(JSON.stringify(check)).not.toContain("must-not-leak")
	})

	test("reports a stranded private key whose registered public half was deleted", () => {
		const check = classifyHostedCanaryConfiguration(environment, secrets, {
			...canaryKey,
			registeredPublicKeys: [],
		})

		expect(check).toMatchObject({ status: "missing" })
		expect(check.detail).toContain("myagentdojo")
		expect(check.repair).toContain("rotate")
	})

	test("rejects an unrelated registered key standing in for the canary key", () => {
		const check = classifyHostedCanaryConfiguration(environment, secrets, {
			...canaryKey,
			registeredPublicKeys: [otherPublicKey],
		})

		expect(check).toMatchObject({ status: "missing" })
		expect(check.detail).toContain("CANARY_SSH_PUBLIC_KEY")
	})

	test("accepts the canary key alongside the actor's unrelated keys", () => {
		expect(
			classifyHostedCanaryConfiguration(environment, secrets, {
				...canaryKey,
				registeredPublicKeys: [otherPublicKey, canaryPublicKey],
			}),
		).toMatchObject({ status: "ready", repair: "" })
	})

	test("matches the canary key regardless of comment or spacing", () => {
		expect(
			classifyHostedCanaryConfiguration(environment, secrets, {
				...canaryKey,
				registeredPublicKeys: [`${canaryPublicKey}  canary@host`],
			}),
		).toMatchObject({ status: "ready" })
	})

	test("reports a missing CANARY_SSH_PUBLIC_KEY binding variable", () => {
		const check = classifyHostedCanaryConfiguration(environment, secrets, {
			...canaryKey,
			expectedPublicKey: "",
		})

		expect(check).toMatchObject({ status: "missing" })
		expect(check.detail).toContain("CANARY_SSH_PUBLIC_KEY")
	})

	test("fails closed when the actor key list was truncated", () => {
		expect(
			classifyHostedCanaryConfiguration(environment, secrets, {
				...canaryKey,
				registeredPublicKeys: [],
				registrationComplete: false,
			}),
		).toMatchObject({ status: "unavailable" })
	})

	describe("repository variable reads", () => {
		test("returns the value across pages", () => {
			expect(
				readRepositoryVariable(
					[
						{ variables: [{ name: "OTHER", value: "x" }] },
						{ variables: [{ name: "CANARY_SSH_PUBLIC_KEY", value: "ssh-ed25519 AAAA" }] },
					],
					"CANARY_SSH_PUBLIC_KEY",
				),
			).toBe("ssh-ed25519 AAAA")
		})

		test("reports a readably absent variable as empty, not unreadable", () => {
			expect(readRepositoryVariable([{ variables: [{ name: "OTHER", value: "x" }] }], "MISSING")).toBe("")
		})

		test.each([
			["non-array response", {}],
			["malformed page", [{ variables: [{ name: "OK", value: "1" }] }, { notVariables: [] }]],
			["malformed entry", [{ variables: [{ value: "no-name" }] }]],
			["non-string value", [{ variables: [{ name: "CANARY_SSH_PUBLIC_KEY", value: 7 }] }]],
		] as const)("fails closed on a %s rather than reporting absent", (_case, response) => {
			expect(readRepositoryVariable(response, "CANARY_SSH_PUBLIC_KEY")).toBeUndefined()
		})
	})

	test("reads the canary actor's keys, never this repository's deploy keys", () => {
		const source = readFileSync(join(root, "scripts", "repository-readiness.ts"), "utf8")

		expect(source).toContain("users/${actor}/keys")
		expect(source).not.toContain("repos/${repository}/keys")
	})

	test("fails closed when the registered public half cannot be read", () => {
		expect(classifyHostedCanaryConfiguration(environment, secrets, undefined)).toMatchObject({
			status: "unavailable",
		})
	})

	test.each([
		["environment metadata", undefined, secrets],
		["wrong environment", { name: "release" }, secrets],
		["secret response", environment, undefined],
		["secret name", environment, { secrets: [{}] }],
	] as const)("fails closed for unreadable %s", (_condition, environmentResponse, secretsResponse) => {
		expect(
			classifyHostedCanaryConfiguration(environmentResponse, secretsResponse),
		).toMatchObject({
			name: "hosted-canary-configuration",
			status: "unavailable",
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
