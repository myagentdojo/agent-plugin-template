import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { validateBunOnlyPayload } from "./build"
import { checkNativeCapabilityFixture } from "./native-capability-fixture"
import { checkGeneratedFiles, loadPluginConfig } from "./plugin-config"
import { RELEASE_PROJECTION_PATH_SET } from "./release-projection"

const root = resolve(import.meta.dir, "..")

const STATIC_CAPABILITY_SIDECAR_PATHS = [
	"plugin/assets/composer-icon.svg",
	"plugin/assets/logo.svg",
	"plugin/hooks/native-capability-hook",
	"plugin/hooks/fixture/lifecycle-mechanics-proof.source.json",
	"plugin/skills/capability-tour/SKILL.md",
	"plugin/skills/capability-tour/references/capability-reviewer.md",
] as const

/** Admit the exact static sidecar inventory and generated capability bytes. */
export function validateCapabilitySidecars(repositoryRoot: string): string[] {
	const config = loadPluginConfig(repositoryRoot)
	const drifted = [
		...checkGeneratedFiles(repositoryRoot, config),
		...checkNativeCapabilityFixture(repositoryRoot),
	]
	if (drifted.length > 0) {
		throw new Error(`generated capability sidecars differ from their sources: ${drifted.join(", ")}`)
	}
	for (const path of STATIC_CAPABILITY_SIDECAR_PATHS) {
		if (!existsSync(join(repositoryRoot, path))) {
			throw new Error(`static capability sidecar is missing: ${path}`)
		}
	}
	return [
		...STATIC_CAPABILITY_SIDECAR_PATHS,
		"plugin/hooks/claude/hooks.json",
		"plugin/hooks/codex/hooks.json",
		"plugin/hooks/fixture/lifecycle-mechanics-proof.generated.json",
	].sort()
}

const help = `Validate release metadata and workflow invariants.

Usage:
  bun run release:validate [--json]
  bun run release:validate --repair --candidate candidate.json --trusted-candidate trusted-candidate.json --repository owner/repo --expected-base-branch main --expected-automation-login LOGIN --tag vX.Y.Z --checkout-sha SHA --tag-sha SHA [--release-target-sha SHA] [--json]
  bun run release:validate --help

Options:
  --repair                    Validate an existing immutable tag before repair.
  --candidate PATH            Persisted publication-candidate record required for repair.
  --trusted-candidate PATH    GitHub-derived pull-request and projection facts for repair.
  --repository OWNER/REPO     Current GitHub repository identity.
  --expected-base-branch REF  Trusted release base branch policy.
  --expected-automation-login LOGIN
                              Trusted Release Please automation identity.
  --tag TAG                   Existing vX.Y.Z tag. Falls back to REPAIR_TAG.
  --checkout-sha SHA          Checked-out commit. Falls back to CHECKOUT_SHA.
  --tag-sha SHA               Resolved immutable tag commit. Falls back to TAG_SHA.
  --release-target-sha SHA    Existing GitHub Release target, when present. Falls back to RELEASE_TARGET_SHA.
  --json                      Emit one JSON result to stdout.
  -h, --help                  Show this help.

Side effects: none. Reads repository files only.
`

/** Files a Release Please version projection may change before publication admission. */
export const ALLOWED_RELEASE_PROJECTION = RELEASE_PROJECTION_PATH_SET

/** Merged pull-request facts resolved from GitHub before any release proof. */
export interface ReleasePullRequestCandidate {
	/** Pull request number. */
	number: number
	/** Pull request base branch. */
	baseBranch: string
	/** GitHub login that authored the automation pull request. */
	automationIdentity: string
	/** Merge commit recorded by GitHub. */
	mergeCommit: string
	/** Repository-relative paths changed by the pull request. */
	changedFiles: string[]
	/** GitHub file status parallel to each changed path. */
	changedFileStatuses: string[]
	/** SHA-256 over the canonical pull-request projection. */
	projectionDigest: string
}

/** Immutable publication admission record persisted before proof. */
export interface PublicationCandidateRecord {
	/** GitHub owner/repository identity. */
	repository: string
	/** Configured release base branch. */
	baseBranch: string
	/** Unique admitted Release Please pull request. */
	pullRequest: number
	/** Expected automation login that authored the pull request. */
	automationIdentity: string
	/** Candidate commit used by proof, tag, package, and Release. */
	mergeCommit: string
	/** Manifest version at the candidate commit. */
	version: string
	/** Immutable tag expected to be absent before proof. */
	tag: string
	/** Required pre-proof tag state. */
	expectedTagState: "absent"
	/** Digest binding the admitted changed-file projection. */
	projectionDigest: string
}

/** Inputs needed to fail closed while admitting a publication candidate. */
export interface CandidateTopology {
	/** Ordered parents of the candidate commit. */
	candidateParentShas: string[]
	/** Trusted base SHA supplied by the publication or repair context. */
	trustedBaseSha: string
	/** Frozen base SHA recorded on the merged pull request. */
	mergedPrBaseSha: string
	/** Reviewed head SHA recorded on the merged pull request. */
	reviewedPrHeadSha: string
}

const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/

/** Reject malformed Git commit identities before topology equality comparisons. */
function validateCandidateTopologyCommitShas(topology: CandidateTopology): void {
	if (
		!Array.isArray(topology.candidateParentShas) ||
		![
			...topology.candidateParentShas,
			topology.trustedBaseSha,
			topology.mergedPrBaseSha,
			topology.reviewedPrHeadSha,
		].every((sha) => typeof sha === "string" && FULL_COMMIT_SHA.test(sha))
	) {
		throw new Error("publication candidate topology contains an invalid commit SHA")
	}
}

export interface PublicationAdmissionInput extends CandidateTopology {
	/** GitHub owner/repository identity. */
	repository: string
	/** Configured release base branch. */
	expectedBaseBranch: string
	/** Automation logins permitted to own Release Please pull requests. */
	expectedAutomationIdentities: string[]
	/** Push event commit that triggered publication resolution. */
	githubSha: string
	/** Version read from the candidate manifest. */
	manifestVersion: string
	/** Whether the candidate version tag already exists remotely. */
	tagExists: boolean
	/** Release-shaped merged pull requests associated with the push commit. */
	candidates: ReleasePullRequestCandidate[]
	/** Previously persisted record, when resuming the same admission. */
	priorRecord?: PublicationCandidateRecord
}

/** Checksum fields that bind a packaged archive to its source candidate. */
export interface PublicationChecksumsBinding {
	/** Canonical source repository URL. */
	repository: string
	/** Commit whose payload was packaged. */
	sourceCommit: string
	/** Immutable version tag. */
	tag: string
	/** Plugin manifest version. */
	version: string
	/** Canonical source runtime-lock digest. */
	runtimeLockSha256: string
	/** Installed bundle-inventory digest. */
	bundleInventorySha256: string
	/** Canonical path-and-byte digest of the complete plugin payload. */
	payloadInventorySha256: string
}

/** Complete pre-publication equality proof. */
export interface PublicationBindingInput {
	/** Persisted publication candidate. */
	candidate: PublicationCandidateRecord
	/** Tag name being published. */
	tag: string
	/** Resolved immutable tag commit. */
	tagSha: string
	/** Version in the checked-out plugin manifest. */
	manifestVersion: string
	/** Commit targeted by the GitHub Release. */
	releaseTargetSha: string
	/** Packaged checksum metadata. */
	checksums: PublicationChecksumsBinding
}

/** Read-only facts required before regenerating or mutating release assets. */
export interface RepairBindingInput {
	/** Existing immutable version tag. */
	tag: string
	/** Commit checked out for regeneration. */
	checkoutSha: string
	/** Commit resolved from the remote tag. */
	tagSha: string
	/** Version read from the checked-out manifest. */
	manifestVersion: string
	/** Existing GitHub Release target, when a Release already exists. */
	releaseTargetSha?: string
}

/** GitHub-derived publication facts required to reproduce repair admission. */
export interface RepairCandidateBindingInput extends RepairBindingInput, CandidateTopology {
	/** Untrusted publication record carried by the annotated tag. */
	candidate: unknown
	/** Current GitHub owner/repository identity. */
	repository: string
	/** Trusted release base branch policy. */
	expectedBaseBranch: string
	/** Trusted automation logins allowed to own the release pull request. */
	expectedAutomationIdentities: string[]
	/** Pull-request and projection facts re-derived from GitHub for this repair. */
	trustedCandidate: ReleasePullRequestCandidate
}

function recordsEqual(left: PublicationCandidateRecord, right: PublicationCandidateRecord): boolean {
	return (
		left.repository === right.repository &&
		left.baseBranch === right.baseBranch &&
		left.pullRequest === right.pullRequest &&
		left.automationIdentity === right.automationIdentity &&
		left.mergeCommit === right.mergeCommit &&
		left.version === right.version &&
		left.tag === right.tag &&
		left.expectedTagState === right.expectedTagState &&
		left.projectionDigest === right.projectionDigest
	)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return (
		Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
	)
}

/** Parse the tag-carried record without allowing missing, extra, or malformed fields. */
export function parsePublicationCandidateRecord(value: unknown): PublicationCandidateRecord {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!hasExactKeys(value as Record<string, unknown>, [
			"repository",
			"baseBranch",
			"pullRequest",
			"automationIdentity",
			"mergeCommit",
			"version",
			"tag",
			"expectedTagState",
			"projectionDigest",
		])
	) {
		throw new Error("publication candidate record shape is invalid")
	}
	const record = value as Record<string, unknown>
	if (
		typeof record.repository !== "string" ||
		typeof record.baseBranch !== "string" ||
		!Number.isInteger(record.pullRequest) ||
		Number(record.pullRequest) <= 0 ||
		typeof record.automationIdentity !== "string" ||
		typeof record.mergeCommit !== "string" ||
		!/^[a-f0-9]{40}$/.test(record.mergeCommit) ||
		typeof record.version !== "string" ||
		typeof record.tag !== "string" ||
		record.expectedTagState !== "absent" ||
		typeof record.projectionDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.projectionDigest)
	) {
		throw new Error("publication candidate record shape is invalid")
	}
	canonicalGitHubRepositoryIdentity(record.repository)
	return record as unknown as PublicationCandidateRecord
}

export function canonicalGitHubRepositoryIdentity(repository: string): string {
	const slug = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository)
	if (slug?.groups) return `github.com/${slug.groups.owner}/${slug.groups.name}`.toLowerCase()
	let url: URL
	try {
		url = new URL(repository)
	} catch {
		throw new Error(`repository is not a canonical GitHub repository: ${repository}`)
	}
	if (
		url.hostname.toLowerCase() !== "github.com" ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash
	) {
		throw new Error(`repository is not a canonical GitHub repository: ${repository}`)
	}
	const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "")
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)) {
		throw new Error(`repository is not a canonical GitHub repository: ${repository}`)
	}
	return `github.com/${path}`.toLowerCase()
}

/**
 * Admit one unique merged Release Please pull request and bind it to the push commit.
 *
 * @param input - GitHub candidate facts and expected release policy
 * @returns Immutable record safe to persist before proof
 * @throws {Error} When uniqueness, identity, merge, projection, or tag-state checks fail
 */
export function admitPublicationCandidate(
	input: PublicationAdmissionInput,
): PublicationCandidateRecord {
	return admitCandidate(input, true)
}

/**
 * Admit a candidate against its supplied projection facts.
 *
 * Historical repair projections are executed by the historical base policy,
 * so the current repair binding must not reinterpret their path allowlist.
 */
function admitCandidate(
	input: PublicationAdmissionInput,
	enforceCurrentProjectionPaths: boolean,
): PublicationCandidateRecord {
	if (input.candidates.length !== 1) {
		throw new Error(
			`publication admission requires exactly one merged Release Please PR; received ${input.candidates.length}`,
		)
	}
	const candidate = input.candidates[0]
	if (candidate.baseBranch !== input.expectedBaseBranch) {
		throw new Error(
			`publication candidate base branch ${candidate.baseBranch} does not match ${input.expectedBaseBranch}`,
		)
	}
	if (!input.expectedAutomationIdentities.includes(candidate.automationIdentity)) {
		throw new Error(`publication candidate has unexpected automation identity ${candidate.automationIdentity}`)
	}
	if (candidate.mergeCommit !== input.githubSha) {
		throw new Error("publication candidate merge commit does not equal github.sha")
	}
	validateCandidateTopologyCommitShas(input)
	if (input.candidateParentShas.length !== 1 && input.candidateParentShas.length !== 2) {
		throw new Error("publication candidate must have exactly one or two parents")
	}
	const [baseParent, reviewedHeadParent] = input.candidateParentShas
	if (baseParent !== input.trustedBaseSha) {
		throw new Error("publication candidate first parent does not match the trusted base")
	}
	if (baseParent !== input.mergedPrBaseSha) {
		throw new Error("publication candidate first parent does not match the merged PR base")
	}
	if (input.candidateParentShas.length === 2 && reviewedHeadParent !== input.reviewedPrHeadSha) {
		throw new Error("publication candidate second parent does not match the reviewed PR head")
	}
	if (
		candidate.changedFiles.length === 0 ||
		new Set(candidate.changedFiles).size !== candidate.changedFiles.length ||
		(enforceCurrentProjectionPaths &&
			candidate.changedFiles.some((path) => !ALLOWED_RELEASE_PROJECTION.has(path)))
	) {
		throw new Error("publication candidate changed files outside the allowed release projection")
	}
	if (
		candidate.changedFileStatuses.length !== candidate.changedFiles.length ||
		candidate.changedFileStatuses.some((status) => status !== "modified")
	) {
		throw new Error("publication candidate used an unsupported file status")
	}
	if (!/^[a-f0-9]{64}$/.test(candidate.projectionDigest)) {
		throw new Error("publication candidate projection digest must be a SHA-256")
	}
	if (input.tagExists) {
		throw new Error(`publication candidate tag v${input.manifestVersion} must be absent before proof`)
	}

	const record: PublicationCandidateRecord = {
		repository: input.repository,
		baseBranch: input.expectedBaseBranch,
		pullRequest: candidate.number,
		automationIdentity: candidate.automationIdentity,
		mergeCommit: candidate.mergeCommit,
		version: input.manifestVersion,
		tag: `v${input.manifestVersion}`,
		expectedTagState: "absent",
		projectionDigest: candidate.projectionDigest,
	}
	if (input.priorRecord && !recordsEqual(input.priorRecord, record)) {
		throw new Error("persisted publication candidate record is rebound to another release identity")
	}
	return input.priorRecord ?? record
}

/**
 * Prove that tag, package, manifest, and GitHub Release identify one candidate commit.
 *
 * @param input - Candidate plus every publication binding
 * @returns The unchanged admitted candidate
 * @throws {Error} When any release identity or commit differs
 */
export function validatePublicationBinding(
	input: PublicationBindingInput,
): PublicationCandidateRecord {
	const { candidate, checksums } = input
	if (input.tag !== candidate.tag) throw new Error("publication tag does not match candidate tag")
	if (input.tagSha !== candidate.mergeCommit) {
		throw new Error("immutable tag target does not match candidate merge commit")
	}
	if (input.releaseTargetSha !== candidate.mergeCommit) {
		throw new Error("GitHub Release target does not match candidate merge commit")
	}
	if (input.manifestVersion !== candidate.version) {
		throw new Error("manifest version does not match publication candidate")
	}
	if (checksums.sourceCommit !== candidate.mergeCommit) {
		throw new Error("packaged source commit does not match publication candidate")
	}
	if (checksums.tag !== candidate.tag || checksums.version !== candidate.version) {
		throw new Error("packaged tag or version does not match publication candidate")
	}
	if (
		canonicalGitHubRepositoryIdentity(checksums.repository) !==
		canonicalGitHubRepositoryIdentity(candidate.repository)
	) {
		throw new Error("packaged GitHub repository does not match publication candidate")
	}
	for (const field of [
		"runtimeLockSha256",
		"bundleInventorySha256",
		"payloadInventorySha256",
	] as const) {
		if (!/^[a-f0-9]{64}$/.test(checksums[field])) {
			throw new Error(`packaged ${field} is not a SHA-256 closure binding`)
		}
	}
	return candidate
}

/**
 * Validate immutable tag and Release identity before manual asset repair.
 *
 * @param input - Existing tag, checkout, manifest, and optional Release target
 * @returns Normalized tag and immutable commit binding
 * @throws {Error} When repair would cross a tag, commit, or version boundary
 */
export function validateRepairBinding(
	input: RepairBindingInput,
): { tag: string; commit: string; version: string } {
	if (!input.tag) throw new Error("repair tag is required")
	if (!input.tagSha) throw new Error("repair tag must exist")
	if (input.tagSha !== input.checkoutSha) {
		throw new Error("repair tag target does not match checkout SHA")
	}
	if (input.tag !== `v${input.manifestVersion}`) {
		throw new Error(
			`repair tag ${input.tag} does not match manifest version ${input.manifestVersion}`,
		)
	}
	if (input.releaseTargetSha && input.releaseTargetSha !== input.checkoutSha) {
		throw new Error("existing GitHub Release target does not match checkout SHA")
	}
	return { tag: input.tag, commit: input.checkoutSha, version: input.manifestVersion }
}

/** GitHub-derived facts required to resume a merged candidate stranded before its tag. */
export interface ResumeCandidateBindingInput extends CandidateTopology {
	/** Untrusted publication record recovered from the persisted pre-proof artifact. */
	candidate: unknown
	/** Current GitHub owner/repository identity. */
	repository: string
	/** Trusted release base branch policy. */
	expectedBaseBranch: string
	/** Trusted automation logins allowed to own the release pull request. */
	expectedAutomationIdentities: string[]
	/** Pull-request and projection facts re-derived from GitHub for this resume. */
	trustedCandidate: ReleasePullRequestCandidate
	/** Merged candidate commit being resumed. */
	candidateSha: string
	/** Version read from the candidate manifest. */
	manifestVersion: string
	/** Whether the candidate version tag already exists remotely. */
	tagExists: boolean
}

/**
 * Bind a pre-tag resume to the admission its original run already persisted.
 *
 * Resume never mints a new admission. It replays the original record against
 * freshly derived GitHub facts, so a candidate that was never admitted, was
 * rebound, or has since been tagged cannot reach protected publication.
 *
 * @param input - Persisted record plus GitHub-derived publication facts
 * @returns The resumed tag, commit, and version
 * @throws {Error} When the candidate is missing, rebound, mismatched, or already tagged
 */
export function validateResumeCandidateBinding(
	input: ResumeCandidateBindingInput,
): { tag: string; commit: string; version: string } {
	const candidate = parsePublicationCandidateRecord(input.candidate)
	admitCandidate({
		repository: input.repository,
		expectedBaseBranch: input.expectedBaseBranch,
		expectedAutomationIdentities: input.expectedAutomationIdentities,
		githubSha: input.candidateSha,
		candidateParentShas: input.candidateParentShas,
		trustedBaseSha: input.trustedBaseSha,
		mergedPrBaseSha: input.mergedPrBaseSha,
		reviewedPrHeadSha: input.reviewedPrHeadSha,
		manifestVersion: input.manifestVersion,
		tagExists: input.tagExists,
		candidates: [input.trustedCandidate],
		priorRecord: candidate,
		// The candidate's first parent already executed its historical projection
		// policy. Rechecking against the current allowlist would reject a valid
		// stranded admission whenever that policy moved on main -- the exact case
		// resume exists to rescue. The persisted digest still binds the projection.
	}, false)
	return { tag: candidate.tag, commit: candidate.mergeCommit, version: candidate.version }
}

/** Bind a manual repair to its original immutable publication admission record. */
export function validateRepairCandidateBinding(
	input: RepairCandidateBindingInput,
): { tag: string; commit: string; version: string } {
	const candidate = parsePublicationCandidateRecord(input.candidate)
	admitCandidate({
		repository: input.repository,
		expectedBaseBranch: input.expectedBaseBranch,
		expectedAutomationIdentities: input.expectedAutomationIdentities,
		githubSha: input.checkoutSha,
		candidateParentShas: input.candidateParentShas,
		trustedBaseSha: input.trustedBaseSha,
		mergedPrBaseSha: input.mergedPrBaseSha,
		reviewedPrHeadSha: input.reviewedPrHeadSha,
		manifestVersion: input.manifestVersion,
		tagExists: false,
		candidates: [input.trustedCandidate],
		priorRecord: candidate,
	}, false)
	return validateRepairBinding(input)
}

function readJson(repositoryRoot: string, path: string): Record<string, any> {
	return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"))
}

type ReleaseWorkflowStep = Record<string, unknown>
type ReleaseWorkflowJob = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Return parsed jobs in their YAML insertion order. */
function releaseWorkflowJobs(workflow: unknown): Record<string, ReleaseWorkflowJob> {
	if (!isRecord(workflow) || !isRecord(workflow.jobs)) return {}
	return Object.fromEntries(
		Object.entries(workflow.jobs).filter(
			(entry): entry is [string, ReleaseWorkflowJob] => isRecord(entry[1]),
		),
	)
}

/** Fetch one parsed workflow job without assuming the YAML document shape. */
function releaseWorkflowJob(workflow: unknown, jobName: string): ReleaseWorkflowJob | undefined {
	return releaseWorkflowJobs(workflow)[jobName]
}

/** Return the object-shaped steps from one parsed workflow job. */
function releaseWorkflowSteps(job: ReleaseWorkflowJob | undefined): ReleaseWorkflowStep[] {
	if (!Array.isArray(job?.steps)) return []
	return job.steps.filter((step): step is ReleaseWorkflowStep => isRecord(step))
}

/** Fetch one named step from a parsed workflow job. */
function releaseWorkflowStep(
	job: ReleaseWorkflowJob | undefined,
	stepName: string,
): ReleaseWorkflowStep | undefined {
	return releaseWorkflowSteps(job).find((step) => step.name === stepName)
}

/** Walk every parsed job step and preserve each uses value for pin validation. */
function releaseWorkflowActionReferences(workflow: unknown): unknown[] {
	return Object.values(releaseWorkflowJobs(workflow)).flatMap((job) =>
		releaseWorkflowSteps(job)
			.filter((step) => Object.hasOwn(step, "uses"))
			.map((step) => step.uses),
	)
}

export type ReleaseWorkflowParityTier = "structural" | "step-run" | "raw-residual"

export type ReleaseWorkflowParityLedgerEntry =
	| {
			literal: string
			tier: ReleaseWorkflowParityTier
			owner: string
			comparison: string
			note?: string
			droppedAspect?: string
			failureMessage?: string
	  }
	| {
			literal: string
			dropReason: string
	  }

/** Migration ledger for every release-workflow assertion in the current raw validator. */
export const RELEASE_WORKFLOW_PARITY_LEDGER = [
	{
		literal: "uses: <action>@<ref> + full-commit-SHA ref",
		tier: "structural",
		owner: "jobs.*.steps[].uses",
		comparison: "all action references match a 40-character lowercase commit SHA",
	},
	{
		literal: "skip-github-release",
		dropReason:
			"The workflow occurrence is comment-only; .github/release-please-config.json skip-github-release=true remains the executable assertion owner.",
	},
	{
		literal: "publication-candidate-${GITHUB_SHA}",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "merge_commit_sha",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "EXPECTED_RELEASE_PLEASE_LOGIN",
		tier: "structural",
		owner:
			"jobs.resolve step Resolve unique candidate or immutable repair tag env.EXPECTED_RELEASE_PLEASE_LOGIN",
		comparison: "field present",
	},
	{
		literal: "PUSH_BEFORE_SHA: ${{ github.event.before }}",
		tier: "structural",
		owner:
			"jobs.resolve step Resolve unique candidate or immutable repair tag env.PUSH_BEFORE_SHA",
		comparison: "equals ${{ github.event.before }}",
	},
	{
		literal: "PUSH_FORCED: ${{ github.event.forced }}",
		tier: "structural",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag env.PUSH_FORCED",
		comparison: "equals ${{ github.event.forced }}",
	},
	{
		literal: 'if [[ "$GITHUB_REF" != "refs/heads/${BASE_BRANCH}" ]]',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'if [[ "$PUSH_FORCED" != "false" ]]',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'git merge-base --is-ancestor "$PUSH_BEFORE_SHA" "$GITHUB_SHA"',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "candidate_parent_shas",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "merged_pr_base_sha",
		tier: "structural",
		owner: "jobs.resolve.outputs.merged_pr_base_sha",
		comparison: "field present",
	},
	{
		literal: "reviewed_pr_head_sha",
		tier: "structural",
		owner: "jobs.resolve.outputs.reviewed_pr_head_sha",
		comparison: "field present",
	},
	{
		literal: "trusted_base_sha",
		tier: "structural",
		owner: "jobs.resolve.outputs.trusted_base_sha",
		comparison: "field present",
	},
	{
		literal: "admitPublicationCandidate",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "validateResumeCandidateBinding",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'if [[ "$OPERATION" == "resume" ]]',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "gh api --include",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "404) return 0 ;;",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "Could not prove whether tag",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "publication-candidate-${RESUME_SHA}",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "Resume requires the persisted publication candidate",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "Detect a merged release candidate stranded before its tag",
		tier: "structural",
		owner: "jobs.maintain.steps[].name",
		comparison: "contains exact step name",
	},
	{
		literal: "-f operation=resume",
		tier: "step-run",
		owner: "jobs.maintain step Detect a merged release candidate stranded before its tag run",
		comparison: "contains",
	},
	{
		literal: "scripts/release-projection.ts",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "bun run prove:all",
		tier: "step-run",
		owner: "jobs.package step Validate and prove release payload run",
		comparison: "contains",
	},
	{
		literal: "git diff --exit-code -- plugin/",
		tier: "step-run",
		owner: "jobs.package step Reject generated release-surface drift run",
		comparison: "contains",
	},
	{
		literal: "ubuntu-24.04-arm",
		tier: "structural",
		owner: "jobs.compatibility.strategy.matrix.include[].runner",
		comparison: "array contains",
	},
	{
		literal: "macos-15-intel",
		tier: "structural",
		owner: "jobs.compatibility.strategy.matrix.include[].runner",
		comparison: "array contains",
	},
	{
		literal: "SOURCE_COMMIT",
		tier: "structural",
		owner: "jobs.package step Validate and prove release payload env.SOURCE_COMMIT",
		comparison: "field present",
	},
	{
		literal: "ref: ${{ needs.resolve.outputs.candidate_sha }}",
		tier: "structural",
		owner: "jobs.{candidate,compatibility,package,release} checkout steps with.ref",
		comparison: "every owner equals ${{ needs.resolve.outputs.candidate_sha }}",
		note: "Strengthens the raw existential check by naming all four candidate checkout owners.",
	},
	{
		literal: "workflow_policy_sha=$(git rev-parse HEAD)",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'git checkout --detach "$workflow_policy_sha"',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'trusted_base_sha=$(git rev-parse "${candidate_sha}^1")',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: 'git checkout --detach "$trusted_base_sha"',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "TRUSTED_BASE_SHA: ${{ needs.resolve.outputs.trusted_base_sha }}",
		tier: "structural",
		owner: "jobs.release step Replay current publication admission before mutation env.TRUSTED_BASE_SHA",
		comparison: "equals ${{ needs.resolve.outputs.trusted_base_sha }}",
	},
	{
		literal: "ADMITTED_MERGED_PR_BASE_SHA: ${{ needs.resolve.outputs.merged_pr_base_sha }}",
		tier: "structural",
		owner:
			"jobs.release step Replay current publication admission before mutation env.ADMITTED_MERGED_PR_BASE_SHA",
		comparison: "equals ${{ needs.resolve.outputs.merged_pr_base_sha }}",
	},
	{
		literal: "ADMITTED_REVIEWED_PR_HEAD_SHA: ${{ needs.resolve.outputs.reviewed_pr_head_sha }}",
		tier: "structural",
		owner:
			"jobs.release step Replay current publication admission before mutation env.ADMITTED_REVIEWED_PR_HEAD_SHA",
		comparison: "equals ${{ needs.resolve.outputs.reviewed_pr_head_sha }}",
	},
	{
		literal: 'trusted_base_sha="$TRUSTED_BASE_SHA"',
		tier: "step-run",
		owner: "jobs.release step Replay current publication admission before mutation run",
		comparison: "contains",
	},
	{
		literal:
			'if [[ "$merged_pr_base_sha" != "$ADMITTED_MERGED_PR_BASE_SHA" || "$reviewed_pr_head_sha" != "$ADMITTED_REVIEWED_PR_HEAD_SHA" ]]',
		tier: "step-run",
		owner: "jobs.release step Replay current publication admission before mutation run",
		comparison: "contains",
	},
	{
		literal: 'git checkout --detach "$CANDIDATE_SHA"',
		tier: "step-run",
		owner: "jobs.release step Replay current publication admission before mutation run",
		comparison: "contains",
	},
	{
		literal: 'if [[ "$(git rev-parse HEAD)" != "$CANDIDATE_SHA" ]]',
		tier: "step-run",
		owner: "jobs.release step Replay current publication admission before mutation run",
		comparison: "contains",
	},
	{
		literal: 'tag -a "$RELEASE_TAG" "$CANDIDATE_SHA" -F persisted-candidate.json',
		tier: "step-run",
		owner: "jobs.release step Create or verify immutable tag run",
		comparison: "contains",
	},
	{
		literal: "git for-each-ref --format='%(contents)'",
		tier: "step-run",
		owner: "jobs.release step Create or verify immutable tag run",
		comparison: "contains",
	},
	{
		literal: 'gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}"',
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "trusted-repair-candidate.json",
		tier: "step-run",
		owner: "jobs.resolve step Resolve unique candidate or immutable repair tag run",
		comparison: "contains",
	},
	{
		literal: "validateRepairCandidateBinding",
		tier: "step-run",
		owner: "jobs.release step Replay current publication admission before mutation run",
		comparison: "contains",
	},
	{
		literal: 'git push origin "refs/tags/${RELEASE_TAG}"',
		tier: "step-run",
		owner: "jobs.release step Create or verify immutable tag run",
		comparison: "contains",
	},
	{
		literal: "remote_tag_sha",
		tier: "step-run",
		owner: "jobs.release step Create or verify immutable tag run",
		comparison: "contains",
	},
	{
		literal: "gh release create",
		tier: "step-run",
		owner: "jobs.release step Create missing GitHub Release and validate target run",
		comparison: "contains",
	},
	{
		literal: "--verify-tag",
		tier: "step-run",
		owner: "jobs.release step Create missing GitHub Release and validate target run",
		comparison: "contains",
	},
	{
		literal: "gh release download",
		tier: "step-run",
		owner: "jobs.release step Compare release assets before mutation run",
		comparison: "contains",
	},
	{
		literal: "gh release upload",
		tier: "step-run",
		owner: "jobs.release step Add or replace admitted release assets run",
		comparison: "contains",
	},
	{
		literal: "*.checksums.json",
		tier: "structural",
		owner: "jobs.package upload-artifact step with.path",
		comparison: "parsed block scalar contains",
	},
	{
		literal: "replace_mismatched_assets",
		tier: "structural",
		owner: "on.workflow_dispatch.inputs.replace_mismatched_assets",
		comparison: "field present",
	},
	{
		literal: "sha256sum",
		tier: "step-run",
		owner: "jobs.release step Compare release assets before mutation run",
		comparison: "contains",
	},
	{
		literal: "group: release-maintenance",
		tier: "structural",
		owner: "jobs.maintain.concurrency.group",
		comparison: "equals release-maintenance",
	},
	{
		literal: "group: release-publication-${{ needs.resolve.outputs.release_tag }}",
		tier: "structural",
		owner: "jobs.release.concurrency.group",
		comparison: "equals release-publication-${{ needs.resolve.outputs.release_tag }}",
	},
	{
		literal: "release-candidate-${{ github.run_id }}",
		tier: "structural",
		owner: "jobs.package upload-artifact with.name and jobs.release download env.ARTIFACT_NAME",
		comparison: "producer and consumer equal",
	},
	{
		literal: "release-platform-candidate-${{ github.run_id }}",
		tier: "structural",
		owner:
			"jobs.candidate upload-artifact with.name and jobs.{compatibility,package} download env.ARTIFACT_NAME",
		comparison: "producer and consumers equal",
	},
	{
		literal: "bun run prove:runtime-platform",
		tier: "step-run",
		owner: "jobs.compatibility step Prove packaged runtime custody on this target run",
		comparison: "contains",
	},
	{
		literal: "--fixture-acknowledged",
		tier: "step-run",
		owner: "jobs.compatibility step Prove packaged runtime custody on this target run",
		comparison: "contains",
	},
	{
		literal: 'cmp --silent "$candidate_archive" "$rebuilt_archive"',
		tier: "step-run",
		owner: "jobs.package step Compare the rebuilt package with the platform-proven candidate run",
		comparison: "contains",
	},
	{
		literal: "overwrite: true",
		tier: "structural",
		owner: "jobs.{candidate,package} upload-artifact steps with.overwrite",
		comparison: "every owner equals boolean true",
	},
	{
		literal: "environment: release",
		tier: "structural",
		owner: "jobs.release.environment",
		comparison: "equals release",
	},
	{
		literal: "gh attestation verify",
		tier: "step-run",
		owner: "jobs.release step Check for existing matching public attestation run",
		comparison: "contains",
	},
	{
		literal: "actions/attest",
		tier: "structural",
		owner: "jobs.release step Add missing public release attestation uses",
		comparison: "action name equals actions/attest",
	},
	{
		literal: "github.event.repository.private == false",
		tier: "structural",
		owner:
			"jobs.release steps Check for existing matching public attestation and Add missing public release attestation if",
		comparison: "every owner expression contains",
	},
	{
		literal: "parent_count",
		tier: "raw-residual",
		owner: ".github/workflows/release.yml raw text",
		comparison: "forbidden anywhere including comments",
	},
	{
		literal: "mergeMode",
		tier: "raw-residual",
		owner: ".github/workflows/release.yml raw text",
		comparison: "forbidden anywhere including comments",
	},
	{
		literal: "github.run_attempt",
		tier: "raw-residual",
		owner: ".github/workflows/release.yml raw text",
		comparison: "forbidden anywhere including comments",
	},
	{
		literal: "/^concurrency:/m",
		tier: "structural",
		owner: "workflow.concurrency",
		comparison: "field absent",
	},
	{
		literal: "\n  maintain:\n",
		tier: "structural",
		owner: "jobs.maintain",
		comparison: "field present before jobs.compatibility",
	},
	{
		literal: "\n  compatibility:\n",
		tier: "structural",
		owner: "jobs.compatibility",
		comparison: "field present after jobs.maintain",
	},
	{
		literal: "\n  release:\n",
		tier: "structural",
		owner: "jobs.release",
		comparison: "field present before jobs.converge",
	},
	{
		literal: "\n  converge:\n",
		tier: "structural",
		owner: "jobs.converge",
		comparison: "field present after jobs.release",
	},
	{
		literal: "group: release-maintenance",
		tier: "structural",
		owner: "jobs.maintain.concurrency.group",
		comparison: "equals release-maintenance",
	},
	{
		literal: "cancel-in-progress: false",
		tier: "structural",
		owner: "jobs.maintain.concurrency.cancel-in-progress",
		comparison: "equals boolean false",
	},
	{
		literal: "persist-credentials: false",
		tier: "structural",
		owner: "jobs.maintain checkout step with.persist-credentials",
		comparison: "equals boolean false",
	},
	{
		literal: "id: bootstrap-version",
		tier: "structural",
		owner: "jobs.maintain step Pin only the first release to v0.1.0 id",
		comparison: "equals bootstrap-version",
	},
	{
		literal: "jq 'length' .github/.release-please-manifest.json",
		tier: "step-run",
		owner: "jobs.maintain step Pin only the first release to v0.1.0 run",
		comparison: "contains",
	},
	{
		literal: 'release_as="0.1.0"',
		tier: "step-run",
		owner: "jobs.maintain step Pin only the first release to v0.1.0 run",
		comparison: "contains",
	},
	{
		literal: "token: ${{ secrets.RELEASE_PLEASE_TOKEN }}",
		tier: "structural",
		owner: "jobs.maintain step Maintain release pull request with.token",
		comparison: "equals ${{ secrets.RELEASE_PLEASE_TOKEN }}",
	},
	{
		literal: "release-as: ${{ steps.bootstrap-version.outputs.release_as }}",
		tier: "structural",
		owner: "jobs.maintain step Maintain release pull request with.release-as",
		comparison: "equals ${{ steps.bootstrap-version.outputs.release_as }}",
	},
	{
		literal: "secrets.GITHUB_TOKEN",
		tier: "structural",
		owner: "jobs.maintain",
		comparison: "absent from parsed job scalar values",
	},
	{
		literal: "    needs:\n      - resolve\n      - package\n",
		tier: "structural",
		owner: "jobs.release.needs",
		comparison: "deep equals [resolve, package]",
	},
	{
		literal: "group: release-publication-${{ needs.resolve.outputs.release_tag }}",
		tier: "structural",
		owner: "jobs.release.concurrency.group",
		comparison: "equals release-publication-${{ needs.resolve.outputs.release_tag }}",
		failureMessage: "release workflow publish mutation must serialize by resolved immutable tag",
	},
	{
		literal:
			"    permissions:\n      actions: read\n      contents: write\n      id-token: write\n      attestations: write\n      issues: write\n      pull-requests: write\n    steps:\n",
		tier: "structural",
		owner: "jobs.release.permissions",
		comparison:
			"deep equals {actions: read, contents: write, id-token: write, attestations: write, issues: write, pull-requests: write}",
		droppedAspect:
			"Raw adjacency and ordering between the permissions block and steps is formatting, not parsed workflow behavior.",
	},
] as const satisfies readonly ReleaseWorkflowParityLedgerEntry[]

type ActiveReleaseWorkflowParityEntry = Extract<
	ReleaseWorkflowParityLedgerEntry,
	{ tier: ReleaseWorkflowParityTier }
>

/** Fetch one object-shaped field from a parsed workflow record. */
function releaseWorkflowRecordField(
	record: Record<string, unknown> | undefined,
	field: string,
): Record<string, unknown> | undefined {
	const value = record?.[field]
	return isRecord(value) ? value : undefined
}

/** Fetch one scalar field from a named workflow step. */
function releaseWorkflowStepField(
	job: ReleaseWorkflowJob | undefined,
	stepName: string,
	field: string,
): unknown {
	return releaseWorkflowStep(job, stepName)?.[field]
}

/** Find an action step by its repository name, independent of the pinned ref. */
function releaseWorkflowActionStep(
	job: ReleaseWorkflowJob | undefined,
	actionName: string,
): ReleaseWorkflowStep | undefined {
	return releaseWorkflowSteps(job).find(
		(step) => typeof step.uses === "string" && step.uses.split("@")[0] === actionName,
	)
}

/** Test every parsed scalar without depending on YAML formatting or comments. */
function releaseWorkflowContainsScalar(value: unknown, literal: string): boolean {
	if (typeof value === "string") return value.includes(literal)
	if (Array.isArray(value)) {
		return value.some((entry) => releaseWorkflowContainsScalar(entry, literal))
	}
	if (isRecord(value)) {
		return Object.values(value).some((entry) => releaseWorkflowContainsScalar(entry, literal))
	}
	return false
}

/** Map each tier-2 ledger owner to the job and step that own its run script. */
const RELEASE_WORKFLOW_OWNED_STEPS: Record<string, readonly [jobName: string, stepName: string]> =
	{
		"jobs.resolve step Resolve unique candidate or immutable repair tag run": [
			"resolve",
			"Resolve unique candidate or immutable repair tag",
		],
		"jobs.maintain step Detect a merged release candidate stranded before its tag run": [
			"maintain",
			"Detect a merged release candidate stranded before its tag",
		],
		"jobs.package step Validate and prove release payload run": [
			"package",
			"Validate and prove release payload",
		],
		"jobs.package step Reject generated release-surface drift run": [
			"package",
			"Reject generated release-surface drift",
		],
		"jobs.release step Replay current publication admission before mutation run": [
			"release",
			"Replay current publication admission before mutation",
		],
		"jobs.release step Create or verify immutable tag run": [
			"release",
			"Create or verify immutable tag",
		],
		"jobs.release step Create missing GitHub Release and validate target run": [
			"release",
			"Create missing GitHub Release and validate target",
		],
		"jobs.release step Compare release assets before mutation run": [
			"release",
			"Compare release assets before mutation",
		],
		"jobs.release step Add or replace admitted release assets run": [
			"release",
			"Add or replace admitted release assets",
		],
		"jobs.compatibility step Prove packaged runtime custody on this target run": [
			"compatibility",
			"Prove packaged runtime custody on this target",
		],
		"jobs.package step Compare the rebuilt package with the platform-proven candidate run": [
			"package",
			"Compare the rebuilt package with the platform-proven candidate",
		],
		"jobs.release step Check for existing matching public attestation run": [
			"release",
			"Check for existing matching public attestation",
		],
		"jobs.maintain step Pin only the first release to v0.1.0 run": [
			"maintain",
			"Pin only the first release to v0.1.0",
		],
	}

/** Resolve the parsed run script named by a tier-2 ledger owner. */
function releaseWorkflowOwnedRun(workflow: unknown, owner: string): string {
	const ownedStep = RELEASE_WORKFLOW_OWNED_STEPS[owner]
	if (!ownedStep) {
		throw new Error(`release workflow parity ledger has no step-run implementation for ${owner}`)
	}
	const run = releaseWorkflowStepField(
		releaseWorkflowJob(workflow, ownedStep[0]),
		ownedStep[1],
		"run",
	)
	return typeof run === "string" ? run : ""
}

/** Match one tier-1 ledger entry against parsed workflow structure. */
function releaseWorkflowStructuralEntryMatches(
	workflow: unknown,
	entry: ActiveReleaseWorkflowParityEntry,
): boolean {
	const resolveJob = releaseWorkflowJob(workflow, "resolve")
	const maintainJob = releaseWorkflowJob(workflow, "maintain")
	const candidateJob = releaseWorkflowJob(workflow, "candidate")
	const compatibilityJob = releaseWorkflowJob(workflow, "compatibility")
	const packageJob = releaseWorkflowJob(workflow, "package")
	const releaseJob = releaseWorkflowJob(workflow, "release")
	const resolveStep = releaseWorkflowStep(resolveJob, "Resolve unique candidate or immutable repair tag")
	const replayStep = releaseWorkflowStep(
		releaseJob,
		"Replay current publication admission before mutation",
	)
	const packageUpload = releaseWorkflowActionStep(packageJob, "actions/upload-artifact")
	const candidateUpload = releaseWorkflowActionStep(candidateJob, "actions/upload-artifact")

	switch (entry.owner) {
		case "jobs.*.steps[].uses": {
			const references = releaseWorkflowActionReferences(workflow)
			return (
				references.length > 0 &&
				references.every(
					(reference) =>
						typeof reference === "string" && /^[^@\s]+@[a-f0-9]{40}$/.test(reference),
				)
			)
		}
		case "jobs.resolve step Resolve unique candidate or immutable repair tag env.EXPECTED_RELEASE_PLEASE_LOGIN":
			return Object.hasOwn(releaseWorkflowRecordField(resolveStep, "env") ?? {}, "EXPECTED_RELEASE_PLEASE_LOGIN")
		case "jobs.resolve step Resolve unique candidate or immutable repair tag env.PUSH_BEFORE_SHA":
			return releaseWorkflowRecordField(resolveStep, "env")?.PUSH_BEFORE_SHA === "${{ github.event.before }}"
		case "jobs.resolve step Resolve unique candidate or immutable repair tag env.PUSH_FORCED":
			return releaseWorkflowRecordField(resolveStep, "env")?.PUSH_FORCED === "${{ github.event.forced }}"
		case "jobs.resolve.outputs.merged_pr_base_sha":
		case "jobs.resolve.outputs.reviewed_pr_head_sha":
		case "jobs.resolve.outputs.trusted_base_sha":
			return Object.hasOwn(
				releaseWorkflowRecordField(resolveJob, "outputs") ?? {},
				entry.literal,
			)
		case "jobs.maintain.steps[].name":
			return releaseWorkflowSteps(maintainJob).some((step) => step.name === entry.literal)
		case "jobs.compatibility.strategy.matrix.include[].runner": {
			const strategy = releaseWorkflowRecordField(compatibilityJob, "strategy")
			const matrix = releaseWorkflowRecordField(strategy, "matrix")
			return (
				Array.isArray(matrix?.include) &&
				matrix.include.some((value) => isRecord(value) && value.runner === entry.literal)
			)
		}
		case "jobs.package step Validate and prove release payload env.SOURCE_COMMIT":
			return Object.hasOwn(
				releaseWorkflowRecordField(
					releaseWorkflowStep(packageJob, "Validate and prove release payload"),
					"env",
				) ?? {},
				"SOURCE_COMMIT",
			)
		case "jobs.{candidate,compatibility,package,release} checkout steps with.ref":
			return [candidateJob, compatibilityJob, packageJob, releaseJob].every(
				(job) =>
					releaseWorkflowRecordField(releaseWorkflowActionStep(job, "actions/checkout"), "with")
						?.ref === "${{ needs.resolve.outputs.candidate_sha }}",
			)
		case "jobs.release step Replay current publication admission before mutation env.TRUSTED_BASE_SHA":
			return releaseWorkflowRecordField(replayStep, "env")?.TRUSTED_BASE_SHA === "${{ needs.resolve.outputs.trusted_base_sha }}"
		case "jobs.release step Replay current publication admission before mutation env.ADMITTED_MERGED_PR_BASE_SHA":
			return releaseWorkflowRecordField(replayStep, "env")?.ADMITTED_MERGED_PR_BASE_SHA === "${{ needs.resolve.outputs.merged_pr_base_sha }}"
		case "jobs.release step Replay current publication admission before mutation env.ADMITTED_REVIEWED_PR_HEAD_SHA":
			return releaseWorkflowRecordField(replayStep, "env")?.ADMITTED_REVIEWED_PR_HEAD_SHA === "${{ needs.resolve.outputs.reviewed_pr_head_sha }}"
		case "jobs.package upload-artifact step with.path": {
			const path = releaseWorkflowRecordField(packageUpload, "with")?.path
			return typeof path === "string" && path.includes(entry.literal)
		}
		case "on.workflow_dispatch.inputs.replace_mismatched_assets": {
			const rootRecord = isRecord(workflow) ? workflow : undefined
			const on = releaseWorkflowRecordField(rootRecord, "on")
			const workflowDispatch = releaseWorkflowRecordField(on, "workflow_dispatch")
			const inputs = releaseWorkflowRecordField(workflowDispatch, "inputs")
			return Object.hasOwn(inputs ?? {}, "replace_mismatched_assets")
		}
		case "jobs.maintain.concurrency.group":
			return releaseWorkflowRecordField(maintainJob, "concurrency")?.group === "release-maintenance"
		case "jobs.release.concurrency.group":
			return releaseWorkflowRecordField(releaseJob, "concurrency")?.group === "release-publication-${{ needs.resolve.outputs.release_tag }}"
		case "jobs.package upload-artifact with.name and jobs.release download env.ARTIFACT_NAME": {
			const producer = releaseWorkflowRecordField(packageUpload, "with")?.name
			const consumer = releaseWorkflowRecordField(
				releaseWorkflowStep(releaseJob, "Download proven release candidate"),
				"env",
			)?.ARTIFACT_NAME
			return producer === entry.literal && consumer === producer
		}
		case "jobs.candidate upload-artifact with.name and jobs.{compatibility,package} download env.ARTIFACT_NAME": {
			const producer = releaseWorkflowRecordField(candidateUpload, "with")?.name
			const consumers = [
				releaseWorkflowStep(compatibilityJob, "Download the single packaged candidate"),
				releaseWorkflowStep(packageJob, "Download the platform-proven release candidate"),
			].map((step) => releaseWorkflowRecordField(step, "env")?.ARTIFACT_NAME)
			return producer === entry.literal && consumers.every((consumer) => consumer === producer)
		}
		case "jobs.{candidate,package} upload-artifact steps with.overwrite":
			return [candidateUpload, packageUpload].every(
				(step) => releaseWorkflowRecordField(step, "with")?.overwrite === true,
			)
		case "jobs.release.environment":
			return releaseJob?.environment === "release"
		case "jobs.release step Add missing public release attestation uses": {
			const uses = releaseWorkflowStep(releaseJob, "Add missing public release attestation")?.uses
			return typeof uses === "string" && uses.split("@")[0] === entry.literal
		}
		case "jobs.release steps Check for existing matching public attestation and Add missing public release attestation if":
			return [
				releaseWorkflowStep(releaseJob, "Check for existing matching public attestation"),
				releaseWorkflowStep(releaseJob, "Add missing public release attestation"),
			].every((step) => typeof step?.if === "string" && step.if.includes(entry.literal))
		case "workflow.concurrency":
			return isRecord(workflow) && !Object.hasOwn(workflow, "concurrency")
		case "jobs.maintain":
			return entry.literal === "secrets.GITHUB_TOKEN"
				? maintainJob !== undefined && !releaseWorkflowContainsScalar(maintainJob, entry.literal)
				: maintainJob !== undefined
		case "jobs.compatibility":
			return compatibilityJob !== undefined
		case "jobs.release":
			return releaseJob !== undefined
		case "jobs.converge":
			return releaseWorkflowJob(workflow, "converge") !== undefined
		case "jobs.maintain.concurrency.cancel-in-progress":
			return releaseWorkflowRecordField(maintainJob, "concurrency")?.["cancel-in-progress"] === false
		case "jobs.maintain checkout step with.persist-credentials":
			return releaseWorkflowRecordField(
				releaseWorkflowActionStep(maintainJob, "actions/checkout"),
				"with",
			)?.["persist-credentials"] === false
		case "jobs.maintain step Pin only the first release to v0.1.0 id":
			return releaseWorkflowStep(maintainJob, "Pin only the first release to v0.1.0")?.id === "bootstrap-version"
		case "jobs.maintain step Maintain release pull request with.token":
			return releaseWorkflowRecordField(
				releaseWorkflowStep(maintainJob, "Maintain release pull request"),
				"with",
			)?.token === "${{ secrets.RELEASE_PLEASE_TOKEN }}"
		case "jobs.maintain step Maintain release pull request with.release-as":
			return releaseWorkflowRecordField(
				releaseWorkflowStep(maintainJob, "Maintain release pull request"),
				"with",
			)?.["release-as"] === "${{ steps.bootstrap-version.outputs.release_as }}"
		case "jobs.release.needs":
			return (
				Array.isArray(releaseJob?.needs) &&
				releaseJob.needs.length === 2 &&
				releaseJob.needs[0] === "resolve" &&
				releaseJob.needs[1] === "package"
			)
		case "jobs.release.permissions": {
			const permissions = releaseWorkflowRecordField(releaseJob, "permissions")
			const expected = {
				actions: "read",
				contents: "write",
				"id-token": "write",
				attestations: "write",
				issues: "write",
				"pull-requests": "write",
			}
			return (
				permissions !== undefined &&
				Object.keys(permissions).length === Object.keys(expected).length &&
				Object.entries(expected).every(([key, value]) => permissions[key] === value)
			)
		}
		default:
			throw new Error(
				`release workflow parity ledger has no structural implementation for ${entry.owner}`,
			)
	}
}

/** Preserve the validator's established diagnostics for ledger assertion failures. */
function releaseWorkflowParityError(entry: ActiveReleaseWorkflowParityEntry): string {
	if (entry.failureMessage !== undefined) return entry.failureMessage
	if (entry.owner === "jobs.*.steps[].uses") {
		return "release workflow actions must be pinned to full commit SHAs"
	}
	if (entry.literal === "parent_count" || entry.literal === "mergeMode") {
		return `release workflow retains unsupported merge-shape metadata: ${entry.literal}`
	}
	if (entry.literal === "github.run_attempt") {
		return "release workflow artifact identity must survive rerun-failed-jobs attempts"
	}
	if (entry.owner === "workflow.concurrency") {
		return "release workflow must serialize only mutation jobs, not discard distinct pending runs"
	}
	if (
		entry.literal === "group: release-maintenance" ||
		entry.literal === "group: release-publication-${{ needs.resolve.outputs.release_tag }}"
	) {
		return `release workflow is missing ${entry.literal}`
	}
	if (entry.owner === "jobs.maintain" || entry.owner === "jobs.compatibility") {
		if (entry.literal === "secrets.GITHUB_TOKEN") {
			return "release workflow maintenance job must not fall back to GITHUB_TOKEN"
		}
		return "release workflow is missing the maintain or compatibility job boundary"
	}
	if (entry.owner === "jobs.release") return "release workflow is missing the release job boundary"
	if (entry.owner === "jobs.converge") return "release workflow is missing the converge job boundary"
	if (
		[
			"cancel-in-progress: false",
			"persist-credentials: false",
			"id: bootstrap-version",
			"jq 'length' .github/.release-please-manifest.json",
			'release_as="0.1.0"',
			"token: ${{ secrets.RELEASE_PLEASE_TOKEN }}",
			"release-as: ${{ steps.bootstrap-version.outputs.release_as }}",
		].includes(entry.literal)
	) {
		return `release workflow maintenance job is missing ${entry.literal}`
	}
	if (entry.owner === "jobs.release.needs") {
		return "release workflow publish job must depend on package"
	}
	if (entry.owner === "jobs.release.permissions") {
		return "release workflow publish job permissions must match the protected release contract"
	}
	return `release workflow is missing ${entry.literal}`
}

/** Implement every non-drop parity-ledger entry at its recorded assertion tier. */
function validateReleaseWorkflowParity(workflowSource: string, workflow: unknown): void {
	const jobNames = Object.keys(releaseWorkflowJobs(workflow))
	const maintainPosition = jobNames.indexOf("maintain")
	const compatibilityPosition = jobNames.indexOf("compatibility")
	if (
		releaseWorkflowJob(workflow, "maintain") === undefined ||
		releaseWorkflowJob(workflow, "compatibility") === undefined ||
		compatibilityPosition <= maintainPosition
	) {
		throw new Error("release workflow is missing the maintain or compatibility job boundary")
	}
	const releasePosition = jobNames.indexOf("release")
	const convergePosition = jobNames.indexOf("converge")
	if (releaseWorkflowJob(workflow, "release") === undefined) {
		throw new Error("release workflow is missing the release job boundary")
	}
	if (releaseWorkflowJob(workflow, "converge") === undefined) {
		throw new Error("release workflow is missing the converge job boundary")
	}
	if (convergePosition <= releasePosition) {
		throw new Error("release workflow converge job must follow the release job")
	}

	for (const entry of RELEASE_WORKFLOW_PARITY_LEDGER) {
		if ("dropReason" in entry) continue
		let matches: boolean
		switch (entry.tier) {
			case "structural":
				matches = releaseWorkflowStructuralEntryMatches(workflow, entry)
				break
			case "step-run":
				matches = releaseWorkflowOwnedRun(workflow, entry.owner).includes(entry.literal)
				break
			case "raw-residual":
				matches = !workflowSource.includes(entry.literal)
				break
		}
		if (!matches) throw new Error(releaseWorkflowParityError(entry))
	}
}

function validateRepository(repositoryRoot: string) {
	validateBunOnlyPayload(repositoryRoot)
	const capabilitySidecars = validateCapabilitySidecars(repositoryRoot)
	const packageJson = readJson(repositoryRoot, "package.json")
	const pluginConfig = readJson(repositoryRoot, "plugin.config.json")
	const claudeMarketplace = readJson(repositoryRoot, ".claude-plugin/marketplace.json")
	const claudeManifest = readJson(repositoryRoot, "plugin/.claude-plugin/plugin.json")
	const codexManifest = readJson(repositoryRoot, "plugin/.codex-plugin/plugin.json")
	const releaseManifest = readJson(repositoryRoot, ".github/.release-please-manifest.json")
	const releaseConfig = readJson(repositoryRoot, ".github/release-please-config.json")
	const releaseWorkflow = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
	let parsedReleaseWorkflow: unknown
	try {
		parsedReleaseWorkflow = Bun.YAML.parse(releaseWorkflow)
	} catch {
		throw new Error("release workflow YAML could not be parsed")
	}
	const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8")

	const version = pluginConfig.version
	const releasedVersion = releaseManifest["."]
	const releaseState = releasedVersion === undefined ? "bootstrap" : "released"
	const releaseManifestKeys = Object.keys(releaseManifest)
	const versionSurfaces = [
		["package.json", packageJson.version],
		["Claude marketplace metadata", claudeMarketplace.metadata?.version],
		["Claude manifest", claudeManifest.version],
		["Codex manifest", codexManifest.version],
	] as const

	for (const [name, actual] of versionSurfaces) {
		if (actual !== version) {
			throw new Error(`${name} version ${String(actual)} does not match plugin.config.json ${version}`)
		}
	}
	if (
		claudeManifest.hooks !== "./hooks/claude/hooks.json" ||
		codexManifest.hooks !== "./hooks/codex/hooks.json"
	) {
		throw new Error("native manifests must reference the exact client-specific hook declarations")
	}

	if (releaseState === "bootstrap") {
		if (releaseManifestKeys.length !== 0) throw new Error("bootstrap release-please manifest must be empty")
		if (version !== "0.1.0") {
			throw new Error("an empty release-please manifest is valid only while bootstrapping v0.1.0")
		}
	} else if (releasedVersion !== version) {
		throw new Error(
			`release-please manifest version ${String(releasedVersion)} does not match plugin.config.json ${version}`,
		)
	} else if (releaseManifestKeys.length !== 1) {
		throw new Error("release-please manifest must contain only the root package version")
	}

	if (releaseState === "bootstrap") {
		if (changelog !== "") throw new Error("bootstrap CHANGELOG.md must be empty")
	} else {
		if (!changelog.startsWith("# Changelog\n\n")) {
			throw new Error("released CHANGELOG.md must start with the canonical Changelog heading")
		}
		if (/^## Changelog$/m.test(changelog)) {
			throw new Error("CHANGELOG.md must not contain a duplicate Changelog heading")
		}
	}

	if (packageJson.private !== true || "publish" in (packageJson.scripts ?? {})) {
		throw new Error("package.json must remain private and must not define an npm publish script")
	}

	const packageRelease = releaseConfig.packages?.["."]
	if (packageRelease?.["release-type"] !== "node") throw new Error("release type must be node")
	if (packageRelease?.["initial-version"] !== "0.1.0") {
		throw new Error("initial release version must be pinned to 0.1.0")
	}
	if (releaseConfig["include-component-in-tag"] !== false) {
		throw new Error("release tags must use the single-plugin vX.Y.Z form")
	}
	if (releaseConfig["skip-github-release"] !== true) {
		throw new Error("release-please must maintain pull requests without creating tags or Releases")
	}
	if (packageRelease?.["changelog-path"] !== "CHANGELOG.md") {
		throw new Error("release-please must own CHANGELOG.md")
	}

	const expectedExtraFiles = new Set([
		"plugin.config.json::$.version",
		".claude-plugin/marketplace.json::$.metadata.version",
		"plugin/.claude-plugin/plugin.json::$.version",
		"plugin/.codex-plugin/plugin.json::$.version",
	])
	const configuredExtraFiles = new Set(
		(packageRelease?.["extra-files"] ?? []).map((entry: Record<string, string>) =>
			entry.type === "generic"
				? `${entry.path}::generic`
				: `${entry.path}::${entry.jsonpath}`,
		),
	)
	for (const expected of expectedExtraFiles) {
		if (!configuredExtraFiles.has(expected)) {
			throw new Error(`release-please extra-files is missing ${expected}`)
		}
	}
	for (const configured of configuredExtraFiles) {
		if (!expectedExtraFiles.has(configured)) {
			throw new Error(`release-please extra-files is unexpected: ${configured}`)
		}
	}

	validateReleaseWorkflowParity(releaseWorkflow, parsedReleaseWorkflow)

	return {
		ok: true,
		version,
		releaseState,
		changelog: "CHANGELOG.md",
		tag: `v${version}`,
		npmPublicationRequired: false,
		capabilitySidecars,
		automatedClaimBoundary: {
			nativeActivation: "not-proved",
			nativeDelegation: "not-proved",
			qualificationReceiptsIngested: false,
		},
		versionSurfaces: [
			...versionSurfaces.map(([name]) => name),
			...(releaseState === "released" ? ["release-please manifest"] : []),
		],
	}
}

interface ParsedArguments {
	json: boolean
	repair: boolean
	help: boolean
	tag?: string
	checkoutSha?: string
	tagSha?: string
	releaseTargetSha?: string
	candidatePath?: string
	trustedCandidatePath?: string
	repository?: string
	expectedBaseBranch?: string
	expectedAutomationLogin?: string
}

function parseArguments(arguments_: string[]): ParsedArguments {
	const parsed: ParsedArguments = { json: false, repair: false, help: false }
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === "--json") parsed.json = true
		else if (argument === "--repair") parsed.repair = true
		else if (argument === "--help" || argument === "-h") parsed.help = true
		else if ([
			"--tag",
			"--checkout-sha",
			"--tag-sha",
			"--release-target-sha",
			"--candidate",
			"--trusted-candidate",
			"--repository",
			"--expected-base-branch",
			"--expected-automation-login",
		].includes(argument)) {
			const value = arguments_[index + 1]
			if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
			index += 1
			if (argument === "--tag") parsed.tag = value
			else if (argument === "--checkout-sha") parsed.checkoutSha = value
			else if (argument === "--tag-sha") parsed.tagSha = value
			else if (argument === "--release-target-sha") parsed.releaseTargetSha = value
			else if (argument === "--candidate") parsed.candidatePath = value
			else if (argument === "--trusted-candidate") parsed.trustedCandidatePath = value
			else if (argument === "--repository") parsed.repository = value
			else if (argument === "--expected-base-branch") parsed.expectedBaseBranch = value
			else parsed.expectedAutomationLogin = value
		} else throw new Error(`unknown option: ${argument}`)
	}
	return parsed
}

function main(): void {
	let parsed: ParsedArguments
	try {
		parsed = parseArguments(process.argv.slice(2))
	} catch (error) {
		console.error(`release:validate: ${(error as Error).message}`)
		console.error("Run `bun run release:validate -- --help` for usage.")
		process.exit(2)
	}
	if (parsed.help) {
		process.stdout.write(help)
		return
	}

	try {
		const result = validateRepository(root)
		if (parsed.repair) {
			const candidatePath = parsed.candidatePath ?? process.env.PUBLICATION_CANDIDATE_PATH
			if (!candidatePath) throw new Error("publication candidate record is required for repair")
			const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as unknown
			const trustedCandidatePath =
				parsed.trustedCandidatePath ?? process.env.TRUSTED_REPAIR_CANDIDATE_PATH
			if (!trustedCandidatePath) {
				throw new Error("GitHub-derived publication candidate is required for repair")
			}
			const trustedCandidateInput = JSON.parse(readFileSync(trustedCandidatePath, "utf8")) as
				ReleasePullRequestCandidate & CandidateTopology
			const {
				candidateParentShas,
				trustedBaseSha,
				mergedPrBaseSha,
				reviewedPrHeadSha,
				...trustedCandidate
			} = trustedCandidateInput
			const repository = parsed.repository ?? process.env.GITHUB_REPOSITORY
			if (!repository) throw new Error("repository identity is required for repair")
			const expectedBaseBranch = parsed.expectedBaseBranch ?? process.env.BASE_BRANCH
			if (!expectedBaseBranch) throw new Error("expected base branch is required for repair")
			const expectedAutomationLogin =
				parsed.expectedAutomationLogin ?? process.env.EXPECTED_RELEASE_PLEASE_LOGIN
			if (!expectedAutomationLogin) {
				throw new Error("expected automation identity is required for repair")
			}
			const repair = validateRepairCandidateBinding({
				candidate,
				repository,
				expectedBaseBranch,
				expectedAutomationIdentities: [expectedAutomationLogin],
				trustedCandidate,
				candidateParentShas,
				trustedBaseSha,
				mergedPrBaseSha,
				reviewedPrHeadSha,
				tag: parsed.tag ?? process.env.REPAIR_TAG ?? "",
				checkoutSha: parsed.checkoutSha ?? process.env.CHECKOUT_SHA ?? "",
				tagSha: parsed.tagSha ?? process.env.TAG_SHA ?? "",
				manifestVersion: result.version,
				releaseTargetSha:
					(parsed.releaseTargetSha ?? process.env.RELEASE_TARGET_SHA) || undefined,
			})
			if (parsed.json) console.log(JSON.stringify({ ...result, mode: "repair", repair }))
			else console.log(`Release repair binding valid for ${repair.tag} at ${repair.commit}.`)
		} else if (parsed.json) console.log(JSON.stringify(result))
		else console.log(`Release metadata valid for ${result.tag}. No npm publication required.`)
	} catch (error) {
		console.error(`release:validate: ${(error as Error).message}`)
		process.exit(1)
	}
}

if (import.meta.main) main()
