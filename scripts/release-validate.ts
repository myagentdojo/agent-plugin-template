import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { RELEASE_PROJECTION_PATH_SET } from "./release-projection"

const root = resolve(import.meta.dir, "..")

const help = `Validate release metadata and workflow invariants.

Usage:
  bun run release:validate [--json]
  bun run release:validate --repair --candidate candidate.json --repository owner/repo --tag vX.Y.Z --checkout-sha SHA --tag-sha SHA [--release-target-sha SHA] [--json]
  bun run release:validate --help

Options:
  --repair                    Validate an existing immutable tag before repair.
  --candidate PATH            Persisted publication-candidate record required for repair.
  --repository OWNER/REPO     Current GitHub repository identity.
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
	/** Merge mode inferred from the candidate commit shape. */
	mergeMode: "merge" | "squash" | "rebase"
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
export interface PublicationAdmissionInput {
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

function recordsEqual(left: PublicationCandidateRecord, right: PublicationCandidateRecord): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
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
	if (candidate.mergeMode !== "merge") {
		throw new Error(`publication candidate merge mode ${candidate.mergeMode} is unsupported`)
	}
	if (
		candidate.changedFiles.length === 0 ||
		new Set(candidate.changedFiles).size !== candidate.changedFiles.length ||
		candidate.changedFiles.some((path) => !ALLOWED_RELEASE_PROJECTION.has(path))
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

/** Bind a manual repair to its original immutable publication admission record. */
export function validateRepairCandidateBinding(
	input: RepairBindingInput & {
		candidate: PublicationCandidateRecord
		repository: string
	},
): { tag: string; commit: string; version: string } {
	if (
		canonicalGitHubRepositoryIdentity(input.candidate.repository) !==
		canonicalGitHubRepositoryIdentity(input.repository)
	) {
		throw new Error("repair repository does not match publication candidate")
	}
	if (
		input.candidate.tag !== input.tag ||
		input.candidate.mergeCommit !== input.checkoutSha ||
		input.candidate.version !== input.manifestVersion
	) {
		throw new Error("repair tag, commit, or version does not match publication candidate")
	}
	return validateRepairBinding(input)
}

function readJson(repositoryRoot: string, path: string): Record<string, any> {
	return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"))
}

function validateRepository(repositoryRoot: string) {
	const packageJson = readJson(repositoryRoot, "package.json")
	const pluginConfig = readJson(repositoryRoot, "plugin.config.json")
	const claudeMarketplace = readJson(repositoryRoot, ".claude-plugin/marketplace.json")
	const claudeManifest = readJson(repositoryRoot, "plugin/.claude-plugin/plugin.json")
	const codexManifest = readJson(repositoryRoot, "plugin/.codex-plugin/plugin.json")
	const codexHooks = readJson(repositoryRoot, "plugin/hooks/codex/hooks.json")
	const releaseManifest = readJson(repositoryRoot, ".github/.release-please-manifest.json")
	const releaseConfig = readJson(repositoryRoot, ".github/release-please-config.json")
	const generatedRuntime = readFileSync(join(repositoryRoot, "plugin/runtime/hello-world.js"), "utf8")
	const releaseWorkflow = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8")
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
	for (const event of ["SessionStart", "Stop"]) {
		const command = codexHooks.hooks?.[event]?.[0]?.hooks?.[0]?.command
		if (!String(command).includes(`--plugin-version ${version}`)) {
			throw new Error(`generated Codex ${event} hook does not bind plugin version ${version}`)
		}
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
	} else if (/^## Changelog$/m.test(changelog)) {
		throw new Error("CHANGELOG.md must not contain a duplicate Changelog heading")
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
		"plugin/hooks/codex/hooks.json::generic",
		"plugin/runtime/hello-world.js::generic",
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

	for (const marker of [
		"x-release-please-start-version",
		`const PLUGIN_VERSION = ${JSON.stringify(version)};`,
		"x-release-please-end",
	]) {
		if (!generatedRuntime.includes(marker)) throw new Error(`generated runtime is missing ${marker}`)
	}

	const actionReferences = [...releaseWorkflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
		(match) => match[1],
	)
	if (
		actionReferences.length === 0 ||
		actionReferences.some((reference) => !/^[a-f0-9]{40}$/.test(reference))
	) {
		throw new Error("release workflow actions must be pinned to full commit SHAs")
	}
	for (const required of [
		"skip-github-release",
		"publication-candidate-${GITHUB_SHA}",
		"merge_commit_sha",
		"EXPECTED_RELEASE_PLEASE_LOGIN",
		"parent_count",
		"scripts/release-projection.ts",
		'expectedTagState:"absent"',
		"bun run prove:all",
		"git diff --exit-code -- plugin/runtime/hello-world.js plugin/hooks/codex/hooks.json",
		"ubuntu-24.04-arm",
		"macos-15-intel",
		"SOURCE_COMMIT",
		"ref: ${{ needs.resolve.outputs.candidate_sha }}",
		"bun run release:validate -- --repair",
		"git tag \"$RELEASE_TAG\" \"$CANDIDATE_SHA\"",
		"git push origin \"refs/tags/${RELEASE_TAG}\"",
		"remote_tag_sha",
		"gh release create",
		"--verify-tag",
		"gh release download",
		"gh release upload",
		"*.checksums.json",
		"replace_mismatched_assets",
		"sha256sum",
		"group: release-maintenance",
		"group: release-publication-${{ needs.resolve.outputs.release_tag }}",
		"release-candidate-${{ github.run_id }}",
		"overwrite: true",
		"environment: release",
		"gh attestation verify",
		"actions/attest",
		"github.event.repository.private == false",
	]) {
		if (!releaseWorkflow.includes(required)) throw new Error(`release workflow is missing ${required}`)
	}
	if (releaseWorkflow.includes("github.run_attempt")) {
		throw new Error("release workflow artifact identity must survive rerun-failed-jobs attempts")
	}
	if (/^concurrency:/m.test(releaseWorkflow)) {
		throw new Error("release workflow must serialize only mutation jobs, not discard distinct pending runs")
	}
	const maintainJob = releaseWorkflow.slice(
		releaseWorkflow.indexOf("\n  maintain:\n"),
		releaseWorkflow.indexOf("\n  compatibility:\n"),
	)
	for (const required of [
		"group: release-maintenance",
		"cancel-in-progress: false",
		"persist-credentials: false",
		"id: bootstrap-version",
		"jq 'length' .github/.release-please-manifest.json",
		'release_as="0.1.0"',
		"token: ${{ secrets.RELEASE_PLEASE_TOKEN }}",
		"release-as: ${{ steps.bootstrap-version.outputs.release_as }}",
	]) {
		if (!maintainJob.includes(required)) {
			throw new Error(`release workflow maintenance job is missing ${required}`)
		}
	}
	if (maintainJob.includes("secrets.GITHUB_TOKEN")) {
		throw new Error("release workflow maintenance job must not fall back to GITHUB_TOKEN")
	}
	const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  release:\n"))
	if (!releaseJob.includes("    needs:\n      - resolve\n      - package\n")) {
		throw new Error("release workflow publish job must depend on package")
	}
	if (!releaseJob.includes("group: release-publication-${{ needs.resolve.outputs.release_tag }}")) {
		throw new Error("release workflow publish mutation must serialize by resolved immutable tag")
	}
	if (!releaseJob.includes("    permissions:\n      actions: read\n")) {
		throw new Error("release workflow publish job must grant actions: read")
	}

	return {
		ok: true,
		version,
		releaseState,
		changelog: "CHANGELOG.md",
		tag: `v${version}`,
		npmPublicationRequired: false,
		versionSurfaces: [
			...versionSurfaces.map(([name]) => name),
			"generated Codex hook definition",
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
	repository?: string
}

function parseArguments(arguments_: string[]): ParsedArguments {
	const parsed: ParsedArguments = { json: false, repair: false, help: false }
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === "--json") parsed.json = true
		else if (argument === "--repair") parsed.repair = true
		else if (argument === "--help" || argument === "-h") parsed.help = true
		else if (["--tag", "--checkout-sha", "--tag-sha", "--release-target-sha", "--candidate", "--repository"].includes(argument)) {
			const value = arguments_[index + 1]
			if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
			index += 1
			if (argument === "--tag") parsed.tag = value
			else if (argument === "--checkout-sha") parsed.checkoutSha = value
			else if (argument === "--tag-sha") parsed.tagSha = value
			else if (argument === "--release-target-sha") parsed.releaseTargetSha = value
			else if (argument === "--candidate") parsed.candidatePath = value
			else parsed.repository = value
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
			const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as PublicationCandidateRecord
			const repository = parsed.repository ?? process.env.GITHUB_REPOSITORY
			if (!repository) throw new Error("repository identity is required for repair")
			const repair = validateRepairCandidateBinding({
				candidate,
				repository,
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
