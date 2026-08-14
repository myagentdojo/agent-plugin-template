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

/** Walk every parsed job and job step and preserve each uses value for pin validation. */
function releaseWorkflowActionReferences(workflow: unknown): unknown[] {
	return Object.values(releaseWorkflowJobs(workflow)).flatMap((job) => [
		...(Object.hasOwn(job, "uses") ? [job.uses] : []),
		...releaseWorkflowSteps(job)
			.filter((step) => Object.hasOwn(step, "uses"))
			.map((step) => step.uses),
	])
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
		owner: "jobs.*.uses + jobs.*.steps[].uses",
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
		owner: "workflow (anywhere)",
		comparison: "group value scalar present anywhere in the parsed workflow",
	},
	{
		literal: "group: release-publication-${{ needs.resolve.outputs.release_tag }}",
		tier: "structural",
		owner: "workflow (anywhere)",
		comparison: "group value scalar present anywhere in the parsed workflow",
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
		failureMessage: "release workflow maintenance job is missing group: release-maintenance",
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
		case "jobs.*.uses + jobs.*.steps[].uses": {
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
		case "workflow (anywhere)":
			return releaseWorkflowContainsScalar(workflow, entry.literal.replace(/^group: /, ""))
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
	if (entry.owner === "jobs.*.uses + jobs.*.steps[].uses") {
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
export function validateReleaseWorkflowParity(workflowSource: string, workflow: unknown): void {
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
