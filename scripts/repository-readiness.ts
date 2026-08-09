import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const tagRulesetRepair =
	"Settings > Rules > Rulesets > New tag ruleset: target tags matching v*, enable Restrict deletions and Restrict updates, no bypass actors"
const defaultBranchRepair = "Settings > Branches > Default branch: change the default branch to main"
const directPushRepair =
	"Settings > Rules > Rulesets > Edit the default-branch ruleset: enable Require a pull request before merging and Block force pushes, then remove all bypass actors"
const squashMergeRepair =
	"Settings > General > Pull Requests: enable Allow squash merging"
const mergeHistoryRepair =
	"Settings > General > Pull Requests: enable Allow squash merging"
const actionsRepair =
	"Settings > Actions > General > Actions permissions: enable the actions and reusable workflows used by this repository"
const requiredChecksRepair =
	"Settings > Branches > Branch protection rules: protect main and require every release-path status check"
const workflowAdminRepair =
	"Remove administration from workflow permissions; release publication needs contents: write, never repository administration"
const releaseAutomationRepair =
	"Settings > Secrets and variables > Actions: add secret RELEASE_PLEASE_TOKEN and variable RELEASE_PLEASE_AUTOMATION_LOGIN"
const releaseEnvironmentRepair =
	"Settings > Environments > release > Deployment protection rules: enable Required reviewers and add at least one reviewer"
const hostedCanaryRepair =
	"Settings > Environments > hosted-canary-qualification: create the environment and add secrets CANARY_GH_TOKEN, CANARY_SSH_KNOWN_HOSTS, and CANARY_SSH_PRIVATE_KEY"

const HOSTED_CANARY_ENVIRONMENT = "hosted-canary-qualification"
export const REQUIRED_HOSTED_CANARY_SECRETS = [
	"CANARY_GH_TOKEN",
	"CANARY_SSH_KNOWN_HOSTS",
	"CANARY_SSH_PRIVATE_KEY",
] as const

const help = `Verify human-owned GitHub repository safeguards without changing them.

Usage:
  bun run readiness [--repo <owner/repo>] [--json]

Options:
  --repo <owner/repo>  Repository override (default: GITHUB_REPOSITORY, plugin.config.json, or gh repo view)
  --json               Emit one JSON result on stdout
  -h, --help           Show this help

Safety:
  Read-only. Uses only GitHub GET APIs and local workflow files.
  A missing, unauthorized, or unavailable safeguard fails closed.
`

/** Status of one repository publication safeguard. */
export type ReadinessStatus = "ready" | "missing" | "unauthorized" | "unavailable"

/** One independently repairable repository publication safeguard. */
export interface ReadinessCheck {
	/** Stable safeguard name. */
	name: string
	/** Fail-closed classification. */
	status: ReadinessStatus
	/** Observed state without secrets. */
	detail: string
	/** Exact human-owned repair path, empty only when ready. */
	repair: string
}

/** Local workflow source classified without GitHub access. */
export interface WorkflowSource {
	/** Repository-relative workflow path. */
	path: string
	/** YAML source read from that path. */
	source: string
}

const VERIFIED_ACTION_OWNERS = new Set(["googleapis", "oven-sh"])

/** Release-path checks that must gate merges into main. */
export const REQUIRED_STATUS_CHECKS = [
	"Conventional Commit title",
	"Release impact",
	"Hosted public and private Git canaries",
	"Compatibility (linux-x64)",
	"Compatibility (linux-arm64)",
	"Compatibility (darwin-arm64)",
	"Compatibility (darwin-x64)",
	"Deterministic package",
] as const

interface Options {
	repository?: string
	json: boolean
}

interface ApiSuccess {
	ok: true
	data: unknown
}

interface ApiFailure {
	ok: false
	exitCode: number
	stderr: string
}

type ApiResult = ApiSuccess | ApiFailure

interface ReadinessResult {
	ok: boolean
	repository: string
	runId: string
	sideEffects: "none"
	checks: ReadinessCheck[]
	nextAction: string
}

class ReadinessCliError extends Error {
	constructor(
		readonly category: "usage" | "unavailable",
		message: string,
		readonly repair: string,
	) {
		super(message)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ready(name: string, detail: string): ReadinessCheck {
	return { name, status: "ready", detail, repair: "" }
}

function missing(name: string, detail: string, repair: string): ReadinessCheck {
	return { name, status: "missing", detail, repair }
}

function matchesVersionTags(rule: Record<string, unknown>): boolean {
	if (!isRecord(rule.conditions) || !isRecord(rule.conditions.ref_name)) return false
	const include = rule.conditions.ref_name.include
	const exclude = rule.conditions.ref_name.exclude
	if (!Array.isArray(include) || !include.every((pattern) => typeof pattern === "string")) return false
	if (!Array.isArray(exclude) || exclude.length > 0) return false
	return include.some((pattern) => ["v*", "refs/tags/v*", "~ALL"].includes(pattern))
}

function matchesDefaultBranch(rule: Record<string, unknown>, defaultBranch: string): boolean | undefined {
	if (!isRecord(rule.conditions) || !isRecord(rule.conditions.ref_name)) return undefined
	const include = rule.conditions.ref_name.include
	const exclude = rule.conditions.ref_name.exclude
	if (
		!Array.isArray(include) ||
		!include.every((pattern) => typeof pattern === "string") ||
		!Array.isArray(exclude) ||
		!exclude.every((pattern) => typeof pattern === "string")
	) {
		return undefined
	}
	const matchesBranch = (pattern: string): boolean | undefined => {
		if (["~ALL", "~DEFAULT_BRANCH", defaultBranch, `refs/heads/${defaultBranch}`].includes(pattern)) {
			return true
		}
		try {
			const glob = new Bun.Glob(pattern)
			return glob.match(defaultBranch) || glob.match(`refs/heads/${defaultBranch}`)
		} catch {
			return undefined
		}
	}
	const included = include.map(matchesBranch)
	const excluded = exclude.map(matchesBranch)
	if (included.includes(undefined) || excluded.includes(undefined)) return undefined
	return included.includes(true) && !excluded.includes(true)
}

/**
 * Prove one active, non-bypassable ruleset makes every v* tag immutable.
 *
 * @param rulesets - Detailed repository ruleset API response
 * @returns Tag-ruleset safeguard classification
 *
 * @example
 * ```typescript
 * classifyTagRuleset([{ target: "tag", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "update" }] }])
 * ```
 */
export function classifyTagRuleset(rulesets: unknown): ReadinessCheck {
	if (!Array.isArray(rulesets)) {
		return {
			name: "tag-ruleset",
			status: "unavailable",
			detail: "GitHub returned an unreadable ruleset response; immutable v* tags are unproven",
			repair: tagRulesetRepair,
		}
	}
	for (const value of rulesets) {
		if (!isRecord(value)) continue
		const bypassActors = value.bypass_actors
		const rules = value.rules
		if (
			value.target !== "tag" ||
			value.enforcement !== "active" ||
			!Array.isArray(bypassActors) ||
			bypassActors.length > 0 ||
			!Array.isArray(rules) ||
			!matchesVersionTags(value)
		) {
			continue
		}
		const ruleTypes = new Set(
			rules.flatMap((rule) => (isRecord(rule) && typeof rule.type === "string" ? [rule.type] : [])),
		)
		if (ruleTypes.has("deletion") && ruleTypes.has("update")) {
			return ready("tag-ruleset", "Active v* tag ruleset restricts deletion and updates with no bypass actors")
		}
	}
	return missing(
		"tag-ruleset",
		"No active, no-bypass tag ruleset proves immutable v* tags through deletion and update restrictions",
		tagRulesetRepair,
	)
}

/**
 * Prove main cannot receive an unreviewed direct push or a force push.
 *
 * @param rulesets - Detailed branch rulesets from the GitHub API
 * @param defaultBranch - Repository default branch
 * @returns Direct-push safeguard classification
 *
 * @example
 * ```typescript
 * classifyDirectPushProtection([{ target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "pull_request" }, { type: "non_fast_forward" }] }], "main")
 * ```
 */
export function classifyDirectPushProtection(
	rulesets: unknown,
	defaultBranch: unknown,
): ReadinessCheck {
	if (!Array.isArray(rulesets) || typeof defaultBranch !== "string" || defaultBranch.length === 0) {
		return {
			name: "direct-push-protection",
			status: "unavailable",
			detail: "GitHub returned unreadable branch rulesets or default-branch metadata; direct-push protection is unproven",
			repair: directPushRepair,
		}
	}
	for (const value of rulesets) {
		if (!isRecord(value)) {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned an unreadable branch ruleset; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		if (typeof value.target !== "string") {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned an unreadable branch ruleset; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		if (value.target !== "branch") continue
		if (value.enforcement !== "active") continue
		if (!Array.isArray(value.bypass_actors) || !Array.isArray(value.rules)) {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned an unreadable active branch ruleset; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		const coversDefaultBranch = matchesDefaultBranch(value, defaultBranch)
		if (coversDefaultBranch === undefined) {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned unreadable active branch ruleset conditions; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		if (!coversDefaultBranch || value.bypass_actors.length > 0) continue
		if (value.rules.some((rule) => !isRecord(rule) || typeof rule.type !== "string")) {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned an unreadable branch rule; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		const ruleTypes = new Set(value.rules.map((rule) => rule.type))
		if (ruleTypes.has("pull_request") && ruleTypes.has("non_fast_forward")) {
			return ready(
				"direct-push-protection",
				`Active ${defaultBranch} branch ruleset requires pull requests and blocks force pushes with no bypass actors`,
			)
		}
	}
	return missing(
		"direct-push-protection",
		`No active, no-bypass branch ruleset requires pull requests and blocks force pushes for ${defaultBranch}`,
		directPushRepair,
	)
}

/**
 * Classify repository metadata needed by the verified one-parent or two-parent release design.
 *
 * @param repository - GitHub repository API response
 * @returns Default-branch and squash-merge checks
 *
 * @example
 * ```typescript
 * classifyRepositorySettings({ default_branch: "main", allow_squash_merge: true, allow_merge_commit: false })
 * ```
 */
export function classifyRepositorySettings(repository: unknown): ReadinessCheck[] {
	if (!isRecord(repository)) {
		return [
			{
				name: "default-branch",
				status: "unavailable",
				detail: "GitHub returned unreadable repository metadata; the default branch is unproven",
				repair: defaultBranchRepair,
			},
			{
				name: "squash-merge",
				status: "unavailable",
				detail: "GitHub returned unreadable repository metadata; squash merging is unproven",
				repair: squashMergeRepair,
			},
		]
	}
	const mergeMethodsReadable = typeof repository.allow_squash_merge === "boolean"
	let mergeMethodCheck: ReadinessCheck
	if (!mergeMethodsReadable) {
		mergeMethodCheck = {
			name: "squash-merge",
			status: "unavailable",
			detail: "GitHub returned an unreadable squash-merge setting; the required release path is unproven",
			repair: squashMergeRepair,
		}
	} else if (repository.allow_squash_merge) {
		mergeMethodCheck = ready(
			"squash-merge",
			"Squash merging is allowed for verified one-parent release candidates",
		)
	} else {
		mergeMethodCheck = missing(
			"squash-merge",
			"Squash merging is disabled; ordinary pull requests and release candidates cannot use the required squash path",
			squashMergeRepair,
		)
	}
	return [
		repository.default_branch === "main"
			? ready("default-branch", "Default branch is main")
			: missing(
					"default-branch",
					`Default branch is ${String(repository.default_branch ?? "unset")}; expected main`,
					defaultBranchRepair,
				),
		mergeMethodCheck,
	]
}

/**
 * Accept readable linear-history policy only when squash merging provides a compatible release path.
 *
 * @param branchProtection - Full main branch-protection response, or null when no classic protection exists
 * @param effectiveRules - Effective GitHub ruleset rules for main
 * @param squashMergeEnabled - Readable repository squash-merge capability
 * @returns Merge-history policy classification
 *
 * @example
 * ```typescript
 * classifyMergeHistoryPolicy(null, [{ type: "required_linear_history" }], true)
 * ```
 */
export function classifyMergeHistoryPolicy(
	branchProtection: unknown,
	effectiveRules: unknown,
	squashMergeEnabled: unknown,
): ReadinessCheck {
	if (typeof squashMergeEnabled !== "boolean") {
		return {
			name: "merge-history-policy",
			status: "unavailable",
			detail: "GitHub returned unreadable squash-merge capability; merge history compatibility is unproven",
			repair: mergeHistoryRepair,
		}
	}
	if (branchProtection !== null && !isRecord(branchProtection)) {
		return {
			name: "merge-history-policy",
			status: "unavailable",
			detail: "GitHub returned unreadable main branch protection; merge history policy is unproven",
			repair: mergeHistoryRepair,
		}
	}
	let classicRequiresLinearHistory = false
	if (isRecord(branchProtection) && branchProtection.required_linear_history !== undefined) {
		const linearHistory = branchProtection.required_linear_history
		if (!isRecord(linearHistory) || typeof linearHistory.enabled !== "boolean") {
			return {
				name: "merge-history-policy",
				status: "unavailable",
				detail: "GitHub returned unreadable linear-history branch protection; merge commits are unproven",
				repair: mergeHistoryRepair,
			}
		}
		classicRequiresLinearHistory = linearHistory.enabled
	}
	if (
		!Array.isArray(effectiveRules) ||
		effectiveRules.some((rule) => !isRecord(rule) || typeof rule.type !== "string")
	) {
		return {
			name: "merge-history-policy",
			status: "unavailable",
			detail: "GitHub returned unreadable effective rules for main; merge history policy is unproven",
			repair: mergeHistoryRepair,
		}
	}
	const rulesetRequiresLinearHistory = effectiveRules.some(
		(rule) => rule.type === "required_linear_history",
	)
	if (classicRequiresLinearHistory || rulesetRequiresLinearHistory) {
		return squashMergeEnabled
			? ready(
					"merge-history-policy",
					"Main requires linear history; squash merging provides a compatible one-parent release path",
				)
			: missing(
					"merge-history-policy",
					"Main requires linear history, but squash merging is disabled",
					mergeHistoryRepair,
				)
	}
	return ready(
		"merge-history-policy",
		"Neither classic branch protection nor effective rulesets require linear history on main",
	)
}

/**
 * Verify GitHub Actions is enabled for the repository.
 *
 * @param permissions - GitHub Actions permissions API response
 * @returns Actions availability safeguard classification
 *
 * @example
 * ```typescript
 * classifyActionsPermissions({ enabled: true, allowed_actions: "all" })
 * ```
 */
export function classifyActionsPermissions(
	permissions: unknown,
	selectedActions?: unknown,
	requiredActions: string[] = [],
): ReadinessCheck {
	if (!isRecord(permissions) || typeof permissions.enabled !== "boolean") {
		return {
			name: "actions-permissions",
			status: "unavailable",
			detail: "GitHub returned unreadable Actions permissions; release execution is unproven",
			repair: actionsRepair,
		}
	}
	if (!permissions.enabled) {
		return missing("actions-permissions", "GitHub Actions is disabled", actionsRepair)
	}
	if (permissions.allowed_actions === "all") {
		return ready("actions-permissions", "GitHub Actions and all required actions are enabled")
	}
	if (permissions.allowed_actions === "local_only") {
		return missing(
			"actions-permissions",
			"GitHub Actions allows only local actions; repository workflows require external actions",
			actionsRepair,
		)
	}
	if (permissions.allowed_actions !== "selected") {
		return {
			name: "actions-permissions",
			status: "unavailable",
			detail: "GitHub returned an unreadable allowed-actions policy; release execution is unproven",
			repair: actionsRepair,
		}
	}
	if (
		!isRecord(selectedActions) ||
		typeof selectedActions.github_owned_allowed !== "boolean" ||
		typeof selectedActions.verified_allowed !== "boolean" ||
		!Array.isArray(selectedActions.patterns_allowed) ||
		!selectedActions.patterns_allowed.every((pattern) => typeof pattern === "string")
	) {
		return {
			name: "actions-permissions",
			status: "unavailable",
			detail: "GitHub returned unreadable selected-action permissions; release execution is unproven",
			repair: actionsRepair,
		}
	}
	const patterns = selectedActions.patterns_allowed as string[]
	const matchesPattern = (reference: string): boolean =>
		patterns.some((pattern) => {
			const expression = pattern
				.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
				.replaceAll("*", ".*")
			return new RegExp(`^${expression}$`, "i").test(reference)
		})
	const blocked = requiredActions.filter((reference) => {
		const owner = reference.split("/", 1)[0]?.toLowerCase()
		if (owner === "actions" && selectedActions.github_owned_allowed) return false
		if (owner && VERIFIED_ACTION_OWNERS.has(owner) && selectedActions.verified_allowed) return false
		return !matchesPattern(reference)
	})
	return blocked.length === 0
		? ready("actions-permissions", "GitHub Actions permits every action used by repository workflows")
		: missing(
				"actions-permissions",
				`Selected Actions policy blocks required workflow actions: ${blocked.join(", ")}`,
				actionsRepair,
			)
}

/** Verify only the names of the release-maintenance credential and bound automation identity. */
export function classifyReleaseAutomationConfiguration(
	secretsResponse: unknown,
	variablesResponse: unknown,
): ReadinessCheck {
	if (!isRecord(secretsResponse) || !Array.isArray(secretsResponse.secrets)) {
		return {
			name: "release-automation-configuration",
			status: "unavailable",
			detail: "GitHub returned unreadable Actions secret metadata; release maintenance credentials are unproven",
			repair: releaseAutomationRepair,
		}
	}
	if (!isRecord(variablesResponse) || !Array.isArray(variablesResponse.variables)) {
		return {
			name: "release-automation-configuration",
			status: "unavailable",
			detail: "GitHub returned unreadable Actions variable metadata; release automation identity is unproven",
			repair: releaseAutomationRepair,
		}
	}
	const secretNames = new Set(
		secretsResponse.secrets.flatMap((entry) =>
			isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
		),
	)
	const variableNames = new Set(
		variablesResponse.variables.flatMap((entry) =>
			isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
		),
	)
	const absent = [
		...(!secretNames.has("RELEASE_PLEASE_TOKEN") ? ["secret RELEASE_PLEASE_TOKEN"] : []),
		...(!variableNames.has("RELEASE_PLEASE_AUTOMATION_LOGIN")
			? ["variable RELEASE_PLEASE_AUTOMATION_LOGIN"]
			: []),
	]
	return absent.length === 0
		? ready(
				"release-automation-configuration",
				"Release Please token and automation-login names are configured",
			)
		: missing(
				"release-automation-configuration",
				`Release maintenance is missing ${absent.join(" and ")}`,
				releaseAutomationRepair,
			)
}

/**
 * Require a human reviewer before the release environment exposes publication authority.
 *
 * @param environment - GitHub release-environment API response
 * @returns Required-reviewer safeguard classification
 *
 * @example
 * ```typescript
 * classifyReleaseEnvironmentProtection({ protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }] })
 * ```
 */
export function classifyReleaseEnvironmentProtection(environment: unknown): ReadinessCheck {
	if (!isRecord(environment) || !Array.isArray(environment.protection_rules)) {
		return {
			name: "release-environment-reviewers",
			status: "unavailable",
			detail: "GitHub returned unreadable release-environment protection; required human review is unproven",
			repair: releaseEnvironmentRepair,
		}
	}
	const requiredReviewers = environment.protection_rules.find(
		(rule) => isRecord(rule) && rule.type === "required_reviewers",
	)
	if (
		isRecord(requiredReviewers) &&
		Array.isArray(requiredReviewers.reviewers) &&
		requiredReviewers.reviewers.length > 0
	) {
		return ready(
			"release-environment-reviewers",
			`release requires ${requiredReviewers.reviewers.length} configured reviewer${requiredReviewers.reviewers.length === 1 ? "" : "s"}`,
		)
	}
	return missing(
		"release-environment-reviewers",
		"release has no required-reviewer protection with a configured reviewer",
		releaseEnvironmentRepair,
	)
}

/** Verify hosted-canary qualification authority from environment and secret names only. */
export function classifyHostedCanaryConfiguration(
	environment: unknown,
	secretsResponse: unknown,
): ReadinessCheck {
	if (!isRecord(environment) || environment.name !== HOSTED_CANARY_ENVIRONMENT) {
		return {
			name: "hosted-canary-configuration",
			status: "unavailable",
			detail: "GitHub returned unreadable hosted-canary environment metadata; qualification authority is unproven",
			repair: hostedCanaryRepair,
		}
	}
	if (!isRecord(secretsResponse) || !Array.isArray(secretsResponse.secrets)) {
		return {
			name: "hosted-canary-configuration",
			status: "unavailable",
			detail: "GitHub returned unreadable hosted-canary secret metadata; qualification credentials are unproven",
			repair: hostedCanaryRepair,
		}
	}
	if (
		secretsResponse.secrets.some(
			(entry) => !isRecord(entry) || typeof entry.name !== "string",
		)
	) {
		return {
			name: "hosted-canary-configuration",
			status: "unavailable",
			detail: "GitHub returned a hosted-canary secret without a readable name; qualification credentials are unproven",
			repair: hostedCanaryRepair,
		}
	}
	const configured = new Set(
		secretsResponse.secrets.flatMap((entry) =>
			isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
		),
	)
	const absent = REQUIRED_HOSTED_CANARY_SECRETS.filter((name) => !configured.has(name))
	return absent.length === 0
		? ready(
				"hosted-canary-configuration",
				`${HOSTED_CANARY_ENVIRONMENT} and all required secret names are configured`,
			)
		: missing(
				"hosted-canary-configuration",
				`Hosted-canary qualification is missing environment secret${absent.length === 1 ? "" : "s"}: ${absent.join(", ")}`,
				hostedCanaryRepair,
			)
}

/**
 * Verify every status check needed by the release path protects main.
 *
 * @param protection - Required status checks API response
 * @returns Required-checks safeguard classification
 *
 * @example
 * ```typescript
 * classifyRequiredStatusChecks({ contexts: ["Release impact"] })
 * ```
 */
export function classifyRequiredStatusChecks(protection: unknown): ReadinessCheck {
	if (!isRecord(protection)) {
		return {
			name: "required-status-checks",
			status: "unavailable",
			detail: "GitHub returned unreadable branch protection; release-path checks are unproven",
			repair: requiredChecksRepair,
		}
	}
	const contexts = Array.isArray(protection.contexts)
		? protection.contexts.filter((context): context is string => typeof context === "string")
		: []
	const checks = Array.isArray(protection.checks)
		? protection.checks.flatMap((check) =>
				isRecord(check) && typeof check.context === "string" ? [check.context] : [],
			)
		: []
	const configured = new Set([...contexts, ...checks])
	const absent = REQUIRED_STATUS_CHECKS.filter((check) => !configured.has(check))
	if (absent.length === 0) {
		return ready("required-status-checks", `main requires ${REQUIRED_STATUS_CHECKS.length} release-path checks`)
	}
	return missing(
		"required-status-checks",
		`main does not require: ${absent.join(", ")}`,
		`${requiredChecksRepair}: ${REQUIRED_STATUS_CHECKS.join(", ")}`,
	)
}

function administrationGrant(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(administrationGrant)
	if (!isRecord(value)) return false
	if (isRecord(value.permissions)) {
		const permission = value.permissions.administration
		if (permission !== undefined && permission !== "none") return true
	}
	return Object.values(value).some(administrationGrant)
}

/**
 * Reject local workflows that grant repository-administration authority.
 *
 * @param workflows - Repository workflow YAML sources
 * @returns Local workflow-permission safeguard classification
 *
 * @example
 * ```typescript
 * classifyWorkflowAdminPermissions([{ path: ".github/workflows/release.yml", source: "permissions:\n  contents: read\n" }])
 * ```
 */
export function classifyWorkflowAdminPermissions(workflows: WorkflowSource[]): ReadinessCheck {
	const offenders: string[] = []
	for (const workflow of workflows) {
		let parsed: unknown
		try {
			parsed = Bun.YAML.parse(workflow.source)
		} catch {
			return {
				name: "workflow-administration",
				status: "unavailable",
				detail: `${workflow.path} is not valid YAML; workflow authority is unproven`,
				repair: `Repair ${workflow.path}, then verify ${workflowAdminRepair}`,
			}
		}
		if (administrationGrant(parsed)) offenders.push(workflow.path)
	}
	return offenders.length === 0
		? ready("workflow-administration", "No workflow grants repository-administration authority")
		: missing(
				"workflow-administration",
				`Repository-administration permission appears in: ${offenders.join(", ")}`,
				workflowAdminRepair,
			)
}

/**
 * Convert an unsuccessful read-only API call into a fail-closed safeguard.
 *
 * @param name - Stable safeguard name
 * @param exitCode - Process or HTTP status when available
 * @param stderr - Sanitized gh error text
 * @param repair - Human-owned settings repair path
 * @returns Missing, unauthorized, or unavailable safeguard classification
 *
 * @example
 * ```typescript
 * classifyApiFailure("tag-ruleset", 403, "HTTP 403", "Settings > Rules > Rulesets")
 * ```
 */
export function classifyApiFailure(
	name: string,
	exitCode: number,
	stderr: string,
	repair: string,
): ReadinessCheck {
	const unauthorized =
		[401, 403].includes(exitCode) || /\b(?:401|403)\b|unauthori[sz]ed|forbidden/i.test(stderr)
	const notFound = exitCode === 404 || /\b404\b|not found/i.test(stderr)
	if (!unauthorized && notFound) {
		return {
			name,
			status: "missing",
			detail: "The GitHub API reports that this safeguard is not configured",
			repair,
		}
	}
	return {
		name,
		status: unauthorized ? "unauthorized" : "unavailable",
		detail: unauthorized
			? "The active gh identity cannot prove this safeguard through the GitHub API"
			: "The GitHub API could not be read; this safeguard remains unproven",
		repair,
	}
}

function isNotFoundApiFailure(failure: ApiFailure): boolean {
	return failure.exitCode === 404 || /\b404\b|not found/i.test(failure.stderr)
}

/**
 * Compute readiness without allowing unknown states to pass.
 *
 * @param checks - Independently classified safeguards
 * @returns Aggregate containing the original checks
 *
 * @example
 * ```typescript
 * summarizeReadiness([{ name: "example", status: "ready", detail: "ready", repair: "" }])
 * ```
 */
export function summarizeReadiness(checks: ReadinessCheck[]): { ok: boolean; checks: ReadinessCheck[] } {
	return { ok: checks.every((check) => check.status === "ready"), checks }
}

function optionValue(arguments_: string[], name: string): string | undefined {
	const index = arguments_.indexOf(name)
	if (index === -1) return undefined
	const value = arguments_[index + 1]
	if (!value || value.startsWith("--")) {
		throw new ReadinessCliError("usage", `${name} requires a value`, "bun run readiness -- --help")
	}
	return value
}

function parseOptions(arguments_: string[]): Options | null {
	if (arguments_.includes("--help") || arguments_.includes("-h")) {
		console.log(help)
		return null
	}
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === "--repo") {
			index += 1
			continue
		}
		if (argument !== "--json") {
			throw new ReadinessCliError("usage", `unknown option: ${argument}`, "bun run readiness -- --help")
		}
	}
	return { repository: optionValue(arguments_, "--repo"), json: arguments_.includes("--json") }
}

function repositorySlug(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim().replace(/\.git$/, "")
	const url = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?(?<slug>[^/\s]+\/[^/\s]+)$/.exec(
		trimmed,
	)
	return url?.groups?.slug
}

function spawnGh(arguments_: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["gh", ...arguments_],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	}
}

function resolveRepository(explicit: string | undefined): string {
	const candidates: unknown[] = [explicit, process.env.GITHUB_REPOSITORY]
	const configPath = join(root, "plugin.config.json")
	if (existsSync(configPath)) {
		try {
			const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
			candidates.push(config.repository)
		} catch (error) {
			throw new ReadinessCliError(
				"unavailable",
				`plugin.config.json cannot be read: ${error instanceof Error ? error.message : String(error)}`,
				"Repair plugin.config.json repository or pass --repo <owner/repo>",
			)
		}
	}
	for (const candidate of candidates) {
		if (candidate === undefined) continue
		const slug = repositorySlug(candidate)
		if (slug) return slug
		throw new ReadinessCliError(
			"usage",
			`repository must be owner/repo or a GitHub repository URL: ${String(candidate)}`,
			"Pass --repo <owner/repo> or repair plugin.config.json repository",
		)
	}
	const viewed = spawnGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
	const slug = viewed.exitCode === 0 ? repositorySlug(viewed.stdout) : undefined
	if (slug) return slug
	throw new ReadinessCliError(
		"unavailable",
		"repository could not be resolved from configuration or gh repo view",
		"Pass --repo <owner/repo> or set GITHUB_REPOSITORY",
	)
}

function readApi(endpoint: string, paginate = false): ApiResult {
	const arguments_ = [
		"api",
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version: 2022-11-28",
	]
	if (paginate) arguments_.push("--paginate", "--slurp")
	arguments_.push(endpoint)
	const result = spawnGh(arguments_)
	if (result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, stderr: result.stderr }
	try {
		return { ok: true, data: JSON.parse(result.stdout) }
	} catch {
		return { ok: false, exitCode: result.exitCode, stderr: "GitHub API returned invalid JSON" }
	}
}

function apiFailure(name: string, failure: ApiFailure, settingsRepair: string): ReadinessCheck {
	const authorizationRepair =
		`Authenticate gh with repository Administration: read, inspect ${settingsRepair}, then rerun; never grant repository administration to release automation`
	const availabilityRepair = `Restore gh API access, then rerun; do not enable release automation while ${settingsRepair} is unverified`
	const classified = classifyApiFailure(name, failure.exitCode, failure.stderr, settingsRepair)
	return {
		...classified,
		repair:
			classified.status === "unauthorized"
				? authorizationRepair
				: classified.status === "missing"
					? settingsRepair
					: availabilityRepair,
	}
}

function flattenPages(value: unknown): unknown {
	if (!Array.isArray(value)) return value
	if (value.every(Array.isArray)) return value.flat()
	return value
}

function checkTagRuleset(repository: string): ReadinessCheck {
	const listed = readApi(`repos/${repository}/rulesets?includes_parents=true&per_page=100`, true)
	if (!listed.ok) return apiFailure("tag-ruleset", listed, tagRulesetRepair)
	const summaries = flattenPages(listed.data)
	if (!Array.isArray(summaries)) return classifyTagRuleset(summaries)
	const tagSummaries = summaries.filter((value) => isRecord(value) && value.target === "tag")
	if (tagSummaries.length === 0) return classifyTagRuleset([])
	const details: unknown[] = []
	for (const summary of tagSummaries) {
		if (!isRecord(summary) || typeof summary.id !== "number") {
			return {
				name: "tag-ruleset",
				status: "unavailable",
				detail: "GitHub returned a tag ruleset without a readable id; immutable v* tags are unproven",
				repair: tagRulesetRepair,
			}
		}
		const detailed = readApi(`repos/${repository}/rulesets/${summary.id}?includes_parents=true`)
		if (!detailed.ok) return apiFailure("tag-ruleset", detailed, tagRulesetRepair)
		details.push(detailed.data)
	}
	return classifyTagRuleset(details)
}

function checkDirectPushProtection(repository: string, defaultBranch: unknown): ReadinessCheck {
	const listed = readApi(`repos/${repository}/rulesets?includes_parents=true&per_page=100`, true)
	if (!listed.ok) return apiFailure("direct-push-protection", listed, directPushRepair)
	const summaries = flattenPages(listed.data)
	if (!Array.isArray(summaries)) return classifyDirectPushProtection(summaries, defaultBranch)
	if (summaries.some((value) => !isRecord(value) || typeof value.target !== "string")) {
		return {
			name: "direct-push-protection",
			status: "unavailable",
			detail: "GitHub returned an unreadable ruleset summary; direct-push protection is unproven",
			repair: directPushRepair,
		}
	}
	const branchSummaries = summaries.filter((value) => isRecord(value) && value.target === "branch")
	if (branchSummaries.length === 0) return classifyDirectPushProtection([], defaultBranch)
	const details: unknown[] = []
	for (const summary of branchSummaries) {
		if (!isRecord(summary) || typeof summary.id !== "number") {
			return {
				name: "direct-push-protection",
				status: "unavailable",
				detail: "GitHub returned a branch ruleset without a readable id; direct-push protection is unproven",
				repair: directPushRepair,
			}
		}
		const detailed = readApi(`repos/${repository}/rulesets/${summary.id}?includes_parents=true`)
		if (!detailed.ok) return apiFailure("direct-push-protection", detailed, directPushRepair)
		details.push(detailed.data)
	}
	return classifyDirectPushProtection(details, defaultBranch)
}

function checkMergeHistoryPolicy(repository: string, squashMergeEnabled: unknown): ReadinessCheck {
	const protection = readApi(`repos/${repository}/branches/main/protection`)
	if (!protection.ok && !isNotFoundApiFailure(protection)) {
		return apiFailure("merge-history-policy", protection, mergeHistoryRepair)
	}
	const effectiveRules = readApi(`repos/${repository}/rules/branches/main`)
	if (!effectiveRules.ok) {
		return apiFailure("merge-history-policy", effectiveRules, mergeHistoryRepair)
	}
	return classifyMergeHistoryPolicy(
		protection.ok ? protection.data : null,
		effectiveRules.data,
		squashMergeEnabled,
	)
}

function checkHostedCanaryConfiguration(repository: string): ReadinessCheck {
	const environment = readApi(`repos/${repository}/environments/${HOSTED_CANARY_ENVIRONMENT}`)
	if (!environment.ok) {
		return apiFailure("hosted-canary-configuration", environment, hostedCanaryRepair)
	}
	const secrets = readApi(
		`repos/${repository}/environments/${HOSTED_CANARY_ENVIRONMENT}/secrets`,
	)
	if (!secrets.ok) {
		return apiFailure("hosted-canary-configuration", secrets, hostedCanaryRepair)
	}
	return classifyHostedCanaryConfiguration(environment.data, secrets.data)
}

function localWorkflows(): ReadinessCheck {
	const workflowDirectory = join(root, ".github", "workflows")
	try {
		const workflows = readdirSync(workflowDirectory)
			.filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))
			.sort()
			.map((path) => ({
				path: `.github/workflows/${path}`,
				source: readFileSync(join(workflowDirectory, path), "utf8"),
			}))
		return classifyWorkflowAdminPermissions(workflows)
	} catch (error) {
		return {
			name: "workflow-administration",
			status: "unavailable",
			detail: `Workflow files could not be read: ${error instanceof Error ? error.message : String(error)}`,
			repair: "Restore readable .github/workflows/*.yml files, then rerun readiness",
		}
	}
}

export function actionReferencesFromWorkflows(workflows: string[]): string[] {
	return [
		...new Set(
			workflows
				.flatMap((source) => [
					...source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm),
				])
				.map((match) => match[1])
				.filter((reference) => !reference.startsWith("./")),
		),
	].sort()
}

function localActionReferences(): string[] {
	const workflowDirectory = join(root, ".github", "workflows")
	return actionReferencesFromWorkflows(
		readdirSync(workflowDirectory)
			.filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"))
			.map((path) => readFileSync(join(workflowDirectory, path), "utf8")),
	)
}

function runChecks(repository: string): ReadinessCheck[] {
	const repositoryResponse = readApi(`repos/${repository}`)
	const repositoryData = repositoryResponse.ok && isRecord(repositoryResponse.data)
		? repositoryResponse.data
		: undefined
	const squashMergeEnabled = repositoryData?.allow_squash_merge
	const checks: ReadinessCheck[] = [
		checkTagRuleset(repository),
		checkDirectPushProtection(repository, repositoryData?.default_branch),
		checkMergeHistoryPolicy(repository, squashMergeEnabled),
	]
	if (repositoryResponse.ok) checks.push(...classifyRepositorySettings(repositoryResponse.data))
	else {
		checks.push(
			apiFailure("default-branch", repositoryResponse, defaultBranchRepair),
			apiFailure("squash-merge", repositoryResponse, squashMergeRepair),
		)
	}
	const actions = readApi(`repos/${repository}/actions/permissions`)
	if (!actions.ok) checks.push(apiFailure("actions-permissions", actions, actionsRepair))
	else if (isRecord(actions.data) && actions.data.allowed_actions === "selected") {
		const selectedActions = readApi(`repos/${repository}/actions/permissions/selected-actions`)
		checks.push(
			selectedActions.ok
				? classifyActionsPermissions(actions.data, selectedActions.data, localActionReferences())
				: apiFailure("actions-permissions", selectedActions, actionsRepair),
		)
	} else {
		checks.push(classifyActionsPermissions(actions.data, undefined, localActionReferences()))
	}
	const releaseSecrets = readApi(`repos/${repository}/actions/secrets`)
	const releaseVariables = readApi(`repos/${repository}/actions/variables`)
	if (!releaseSecrets.ok) {
		checks.push(
			apiFailure(
				"release-automation-configuration",
				releaseSecrets,
				releaseAutomationRepair,
			),
		)
	} else if (!releaseVariables.ok) {
		checks.push(
			apiFailure(
				"release-automation-configuration",
				releaseVariables,
				releaseAutomationRepair,
			),
		)
	} else {
		checks.push(classifyReleaseAutomationConfiguration(releaseSecrets.data, releaseVariables.data))
	}
	const requiredChecks = readApi(`repos/${repository}/branches/main/protection/required_status_checks`)
	checks.push(
		requiredChecks.ok
			? classifyRequiredStatusChecks(requiredChecks.data)
			: apiFailure("required-status-checks", requiredChecks, requiredChecksRepair),
	)
	const releaseEnvironment = readApi(`repos/${repository}/environments/release`)
	checks.push(
		releaseEnvironment.ok
			? classifyReleaseEnvironmentProtection(releaseEnvironment.data)
			: apiFailure(
					"release-environment-reviewers",
					releaseEnvironment,
					releaseEnvironmentRepair,
				),
	)
	checks.push(checkHostedCanaryConfiguration(repository))
	checks.push(localWorkflows())
	return checks
}

function renderHuman(result: ReadinessResult): void {
	console.log(`Repository readiness: ${result.ok ? "READY" : "NOT READY"}`)
	console.log(`Repository: ${result.repository}`)
	for (const check of result.checks) {
		console.log(`${check.status === "ready" ? "[READY]" : `[${check.status.toUpperCase()}]`} ${check.name}: ${check.detail}`)
		if (check.repair) console.log(`  Repair: ${check.repair}`)
	}
	console.log(`Next: ${result.nextAction}`)
}

function emitResult(result: ReadinessResult, json: boolean): void {
	if (json) console.log(JSON.stringify(result))
	else renderHuman(result)
}

function main(arguments_: string[], runId: string): void {
	const options = parseOptions(arguments_)
	if (!options) return
	const repository = resolveRepository(options.repository)
	const summary = summarizeReadiness(runChecks(repository))
	const result: ReadinessResult = {
		...summary,
		repository,
		runId,
		sideEffects: "none",
		nextAction: summary.ok
			? "Enable release automation only while these safeguards remain ready"
			: "Apply each human-owned repair, then rerun bun run readiness",
	}
	emitResult(result, options.json)
	if (!result.ok) process.exitCode = 1
}

if (import.meta.main) {
	const arguments_ = process.argv.slice(2)
	const json = arguments_.includes("--json")
	const runId = crypto.randomUUID()
	try {
		main(arguments_, runId)
	} catch (error) {
		const failure =
			error instanceof ReadinessCliError
				? error
				: new ReadinessCliError(
						"unavailable",
						error instanceof Error ? error.message : String(error),
						"Repair the reported failure, then rerun bun run readiness",
					)
		const result: ReadinessResult = {
			ok: false,
			repository: "unresolved",
			runId,
			sideEffects: "none",
			checks: [
				{
					name: "repository-resolution",
					status: failure.category === "usage" ? "missing" : "unavailable",
					detail: failure.message,
					repair: failure.repair,
				},
			],
			nextAction: failure.repair,
		}
		emitResult(result, json)
		process.exitCode = failure.category === "usage" ? 2 : 1
	}
}
