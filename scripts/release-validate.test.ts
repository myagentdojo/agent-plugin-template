import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	admitPublicationCandidate,
	validatePublicationBinding,
	parsePublicationCandidateRecord,
	validateRepairCandidateBinding,
	validateRepairBinding,
} from "./release-validate"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([".dev", ".git", ".worktrees", "dist", "node_modules"])

function copyRepository(): string {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-plugin-release-"))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	return temporaryRoot
}

function validate(cwd: string): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/release-validate.ts", "--json"],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
}

function validateWithArguments(cwd: string, arguments_: string[]): ReturnType<typeof Bun.spawnSync> {
	const {
		PUBLICATION_CANDIDATE_PATH: _candidatePath,
		REPAIR_TAG: _repairTag,
		CHECKOUT_SHA: _checkoutSha,
		TAG_SHA: _tagSha,
		RELEASE_TARGET_SHA: _releaseTargetSha,
		TRUSTED_REPAIR_CANDIDATE_PATH: _trustedCandidatePath,
		BASE_BRANCH: _baseBranch,
		EXPECTED_RELEASE_PLEASE_LOGIN: _automationLogin,
		...environment
	} = process.env
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/release-validate.ts", ...arguments_],
		cwd,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

const allowedProjection = [
	".claude-plugin/marketplace.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
	"package.json",
	"plugin.config.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
	"plugin/hooks/codex/hooks.json",
	"plugin/runtime/hello-world.js",
]

function releasePullRequest(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		baseBranch: "main",
		automationIdentity: "github-actions[bot]",
		mergeCommit: "a".repeat(40),
		mergeMode: "merge" as const,
		changedFiles: allowedProjection,
		changedFileStatuses: allowedProjection.map(() => "modified"),
		projectionDigest: "b".repeat(64),
		...overrides,
	}
}

function admissionInput(candidates = [releasePullRequest()]) {
	return {
		repository: "myagentdojo/agent-plugin-template",
		expectedBaseBranch: "main",
		expectedAutomationIdentities: ["github-actions[bot]"],
		githubSha: "a".repeat(40),
		manifestVersion: "0.1.0",
		tagExists: false,
		candidates,
	}
}

function writeReleasedMetadata(repositoryRoot: string, changelog: (version: string) => string): string {
	const pluginConfig = JSON.parse(readFileSync(join(repositoryRoot, "plugin.config.json"), "utf8"))
	writeFileSync(
		join(repositoryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ ".": pluginConfig.version }, null, 2)}\n`,
	)
	writeFileSync(join(repositoryRoot, "CHANGELOG.md"), changelog(pluginConfig.version))
	return pluginConfig.version
}

test("release metadata has one synchronized semantic version", () => {
	const result = validate(root)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		version: expect.any(String),
		releaseState: "bootstrap",
		changelog: "CHANGELOG.md",
		npmPublicationRequired: false,
	})
})

test("release validation accepts a synchronized post-bootstrap manifest", () => {
	const temporaryRoot = copyRepository()
	const version = writeReleasedMetadata(
		temporaryRoot,
		(value) => `# Changelog\n\n## ${value}\n\nInitial release.\n`,
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		releaseState: "released",
		version,
	})
})

test("released metadata rejects a non-canonical changelog header", () => {
	const temporaryRoot = copyRepository()
	writeReleasedMetadata(temporaryRoot, (version) => `## ${version}\n\nInitial release.\n`)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("canonical Changelog heading")
})

test("release validation rejects a drifted version surface", () => {
	const temporaryRoot = copyRepository()
	const packagePath = join(temporaryRoot, "package.json")
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
	packageJson.version = "9.9.9"
	writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("package.json version")
	expect(result.stderr.toString()).toContain("plugin.config.json")
})

test("release validation rejects unexpected release-please extra-files", () => {
	const temporaryRoot = copyRepository()
	const configPath = join(temporaryRoot, ".github", "release-please-config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8"))
	config.packages["."]["extra-files"].push({
		type: "json",
		path: "package.json",
		jsonpath: "$.version",
	})
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain(
		"release-please extra-files is unexpected: package.json::$.version",
	)
})

test("release validation rejects an empty manifest after v0.1.0", () => {
	const temporaryRoot = copyRepository()
	for (const path of [
		"package.json",
		"plugin.config.json",
		"plugin/.claude-plugin/plugin.json",
		"plugin/.codex-plugin/plugin.json",
	]) {
		const absolutePath = join(temporaryRoot, path)
		const json = JSON.parse(readFileSync(absolutePath, "utf8"))
		json.version = "0.2.0"
		writeFileSync(absolutePath, `${JSON.stringify(json, null, 2)}\n`)
	}
	const marketplacePath = join(temporaryRoot, ".claude-plugin", "marketplace.json")
	const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"))
	marketplace.metadata.version = "0.2.0"
	writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
	const runtimePath = join(temporaryRoot, "plugin", "runtime", "hello-world.js")
	writeFileSync(
		runtimePath,
		readFileSync(runtimePath, "utf8").replace('const PLUGIN_VERSION = "0.1.0";', 'const PLUGIN_VERSION = "0.2.0";'),
	)
	const hooksPath = join(temporaryRoot, "plugin", "hooks", "codex", "hooks.json")
	writeFileSync(
		hooksPath,
		readFileSync(hooksPath, "utf8").replaceAll("--plugin-version 0.1.0", "--plugin-version 0.2.0"),
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("empty release-please manifest")
})

test("release validation rejects unexpected manifest packages", () => {
	const temporaryRoot = copyRepository()
	writeFileSync(
		join(temporaryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ unexpected: "0.1.0" }, null, 2)}\n`,
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("bootstrap release-please manifest must be empty")
})

test("release validation rejects a pre-seeded bootstrap changelog heading", () => {
	const temporaryRoot = copyRepository()
	writeFileSync(join(temporaryRoot, "CHANGELOG.md"), "# Changelog\n")

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("bootstrap CHANGELOG.md must be empty")
})

test("release validation rejects a duplicate changelog heading", () => {
	const temporaryRoot = copyRepository()
	writeReleasedMetadata(
		temporaryRoot,
		() =>
		"# Changelog\n\n## 0.1.0\n\nInitial release.\n\n## Changelog\n",
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("duplicate Changelog heading")
})

test("release workflow is pinned and publishes proven assets after validation", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8")
	const finalReleaseJob = workflow.slice(workflow.indexOf("  release:\n"))
	const compareStepStart = finalReleaseJob.indexOf("      - name: Compare release assets before mutation\n")
	const uploadStepStart = finalReleaseJob.indexOf("      - name: Add or replace admitted release assets\n")
	const attestationStepStart = finalReleaseJob.indexOf("      - name: Check for existing matching public attestation\n")
	const compareStep = finalReleaseJob.slice(compareStepStart, uploadStepStart)
	const uploadStep = finalReleaseJob.slice(uploadStepStart, attestationStepStart)
	const repairValidationStep = workflow.slice(
		workflow.indexOf("      - name: Resolve unique candidate or immutable repair tag\n"),
		workflow.indexOf("\n\n          associated_prs="),
	)
	const persistedCandidateStep = finalReleaseJob.slice(
		finalReleaseJob.indexOf("      - name: Download persisted publication candidate\n"),
		finalReleaseJob.indexOf("      - name: Create or verify immutable tag\n"),
	)
	const actionReferences = [...workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
		(match) => match[1],
	)

	expect(actionReferences.length).toBeGreaterThan(0)
	expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true)
	expect(workflow).toContain("skip-github-release")
	expect(workflow).toContain("publication-candidate-${GITHUB_SHA}")
	expect(workflow).toContain("operation:")
	expect(workflow).toContain("PUBLICATION_CANDIDATE_PATH")
	expect(workflow).toContain("publication-candidate-${CANDIDATE_SHA}")
	expect(workflow).toContain("tag -a \"$RELEASE_TAG\" \"$CANDIDATE_SHA\" -F persisted-candidate.json")
	expect(workflow).toContain("git for-each-ref --format='%(contents)'")
	expect(workflow).toContain('git cat-file -t "refs/tags/${REPAIR_TAG}"')
	expect(workflow).toContain("merge_commit_sha")
	expect(workflow).toContain("EXPECTED_RELEASE_PLEASE_LOGIN")
	expect(workflow).toContain("scripts/release-projection.ts")
	expect(workflow).not.toContain("ALLOWED_RELEASE_PATHS")
	expect(workflow).not.toContain("missing_paths")
	expect(workflow).toContain("parent_count")
	expect(workflow).not.toContain("compare_json_except_version")
	expect(workflow).toContain('expectedTagState:"absent"')
	expect(workflow).toContain("bun run prove:all")
	expect(workflow).toContain("@anthropic-ai/claude-code@2.1.222")
	expect(workflow).toContain("@openai/codex@0.146.1")
	expect(workflow).toContain("SOURCE_COMMIT")
	expect(workflow).toContain("canonicalGitHubRepositoryIdentity")
	expect(workflow).toContain("ref: ${{ needs.resolve.outputs.candidate_sha }}")
	expect(workflow).toContain("tag -a \"$RELEASE_TAG\" \"$CANDIDATE_SHA\" -F persisted-candidate.json")
	expect(workflow).toContain("git push origin \"refs/tags/${RELEASE_TAG}\"")
	expect(workflow).toContain("remote_tag_sha")
	expect(workflow).toContain("gh release create")
	expect(workflow).toContain("--verify-tag")
	expect(workflow).toContain("gh release upload")
	expect(workflow).toContain("*.checksums.json")
	expect(workflow).toContain("replace_mismatched_assets")
	expect(workflow).toContain("gh release download")
	expect(workflow).toContain("sha256sum")
	expect(workflow).not.toMatch(/^concurrency:/m)
	expect(workflow).toContain("group: release-maintenance")
	expect(workflow).toContain("group: release-publication-${{ needs.resolve.outputs.release_tag }}")
	expect(workflow.match(/release-candidate-\$\{\{ github\.run_id \}\}/g)).toHaveLength(2)
	expect(workflow).toContain("overwrite: true")
	expect(workflow).not.toContain("github.run_attempt")
	expect(workflow).toContain("bun run release:validate -- --repair")
	const maintainJob = workflow.slice(
		workflow.indexOf("\n  maintain:\n"),
		workflow.indexOf("\n  compatibility:\n"),
	)
	expect(maintainJob).toContain("persist-credentials: false")
	expect(maintainJob).toContain("group: release-maintenance")
	expect(maintainJob).toContain("id: bootstrap-version")
	expect(maintainJob).toContain("jq 'length' .github/.release-please-manifest.json")
	expect(maintainJob).toContain('release_as="0.1.0"')
	expect(maintainJob).toContain("token: ${{ secrets.RELEASE_PLEASE_TOKEN }}")
	expect(maintainJob).not.toContain("secrets.GITHUB_TOKEN")
	expect(maintainJob).toContain("release-as: ${{ steps.bootstrap-version.outputs.release_as }}")
	expect(finalReleaseJob).toContain("publication-candidate-${CANDIDATE_SHA}")
	expect(finalReleaseJob).toContain('if [[ "$MODE" == "repair" ]]')
	expect(finalReleaseJob).toContain("Immutable release tag carries a different publication admission")
	expect(repairValidationStep).toContain("git for-each-ref --format='%(contents)'")
	expect(repairValidationStep).toContain('gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}"')
	expect(repairValidationStep).toContain("trusted-repair-candidate.json")
	expect(repairValidationStep).toContain("validateRepairCandidateBinding")
	expect(repairValidationStep).not.toContain("actions/artifacts")
	expect(persistedCandidateStep).toContain('if [[ "$MODE" == "repair" ]]')
	expect(persistedCandidateStep).toContain("git for-each-ref --format='%(contents)'")
	expect(finalReleaseJob).toContain("    needs:\n      - resolve\n      - package\n")
	expect(finalReleaseJob).toContain(
		"group: release-publication-${{ needs.resolve.outputs.release_tag }}",
	)
	expect(finalReleaseJob).toContain("    permissions:\n      actions: read\n")
	expect(finalReleaseJob).toContain("PUBLICATION_CANDIDATE_PATH=persisted-candidate.json")
	expect(finalReleaseJob).toContain('--repository "$GITHUB_REPOSITORY"')
	expect(compareStepStart).toBeGreaterThan(-1)
	expect(uploadStepStart).toBeGreaterThan(compareStepStart)
	expect(attestationStepStart).toBeGreaterThan(uploadStepStart)
	expect(compareStep).toContain("asset-actions.tsv")
	expect(compareStep).toContain("expected-assets.txt")
	expect(compareStep).toContain("comm -13 expected-assets.txt remote-assets.txt")
	expect(compareStep).not.toContain("gh release upload")
	expect(uploadStep).toContain("gh release upload")
	expect(uploadStep).not.toContain("gh release download")
	expect(workflow).toContain("environment: release")
	expect(workflow).toContain("gh attestation verify")
	expect(workflow).toContain("actions/attest")
	expect(workflow).not.toContain("ref: ${{ inputs.release_tag || github.sha }}")
	expect(workflow).not.toContain("*.provenance.json")
	expect(workflow).not.toContain("endswith($repository)")
})

test("immutable tag creation is retry-safe and rejects a rebound candidate", () => {
	const workflowSource = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8")
	const workflow = Bun.YAML.parse(workflowSource) as {
		jobs: { release: { steps: Array<{ name?: string; run?: string }> } }
	}
	const tagScript = workflow.jobs.release.steps.find(
		(step) => step.name === "Create or verify immutable tag",
	)?.run
	expect(tagScript).toBeString()

	const temporaryRoot = mkdtempSync(join(tmpdir(), "release-tag-retry-"))
	const origin = join(temporaryRoot, "origin.git")
	const checkout = join(temporaryRoot, "checkout")
	const git = (arguments_: string[], cwd = temporaryRoot) =>
		Bun.spawnSync({ cmd: ["git", ...arguments_], cwd, stdout: "pipe", stderr: "pipe" })
	expect(git(["init", "--bare", origin]).exitCode).toBe(0)
	expect(git(["init", checkout]).exitCode).toBe(0)
	writeFileSync(join(checkout, "payload"), "one\n")
	expect(git(["add", "payload"], checkout).exitCode).toBe(0)
	expect(
		git(
			["-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "one"],
			checkout,
		).exitCode,
	).toBe(0)
	expect(git(["remote", "add", "origin", origin], checkout).exitCode).toBe(0)
	const candidateSha = git(["rev-parse", "HEAD"], checkout).stdout.toString().trim()
	writeFileSync(
		join(checkout, "persisted-candidate.json"),
		`${JSON.stringify(admitPublicationCandidate(admissionInput()))}\n`,
	)
	const execute = (sha: string) =>
		Bun.spawnSync({
			cmd: ["bash", "-euo", "pipefail", "-c", tagScript as string],
			cwd: checkout,
			env: { ...process.env, MODE: "publish", CANDIDATE_SHA: sha, RELEASE_TAG: "v0.1.0" },
			stdout: "pipe",
			stderr: "pipe",
		})

	const first = execute(candidateSha)
	expect(first.exitCode, first.stderr.toString()).toBe(0)
	const retry = execute(candidateSha)
	expect(retry.exitCode, retry.stderr.toString()).toBe(0)
	const taggedAdmission = git(
		["for-each-ref", "--format=%(contents)", "refs/tags/v0.1.0"],
		checkout,
	).stdout.toString()
	expect(JSON.parse(taggedAdmission)).toMatchObject({ tag: "v0.1.0" })
	writeFileSync(join(checkout, "payload"), "two\n")
	expect(git(["add", "payload"], checkout).exitCode).toBe(0)
	expect(
		git(
			["-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "two"],
			checkout,
		).exitCode,
	).toBe(0)
	const reboundSha = git(["rev-parse", "HEAD"], checkout).stdout.toString().trim()
	const rebound = execute(reboundSha)
	expect(rebound.exitCode).toBe(1)
	expect(rebound.stderr.toString()).toContain("Immutable remote tag")
})

test("publication candidate admission binds one merged Release Please PR to github.sha", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	expect(candidate).toMatchObject({
		repository: "myagentdojo/agent-plugin-template",
		baseBranch: "main",
		pullRequest: 42,
		automationIdentity: "github-actions[bot]",
		mergeCommit: "a".repeat(40),
		version: "0.1.0",
		tag: "v0.1.0",
		expectedTagState: "absent",
		projectionDigest: "b".repeat(64),
	})
})

test("publication candidate admission rejects zero matching PRs", () => {
	expect(() => admitPublicationCandidate(admissionInput([]))).toThrow("exactly one merged Release Please PR")
})

test("publication candidate admission rejects multiple matching PRs", () => {
	expect(() =>
		admitPublicationCandidate(admissionInput([releasePullRequest(), releasePullRequest({ number: 43 })])),
	).toThrow("exactly one merged Release Please PR")
})

test("publication candidate admission rejects the wrong base branch", () => {
	expect(() =>
		admitPublicationCandidate(admissionInput([releasePullRequest({ baseBranch: "next" })])),
	).toThrow("base branch")
})

test("publication candidate admission rejects the wrong automation identity", () => {
	expect(() =>
		admitPublicationCandidate(admissionInput([releasePullRequest({ automationIdentity: "octocat" })])),
	).toThrow("automation identity")
})

test("AE2: publication candidate admission rejects a merge commit unequal to github.sha", () => {
	expect(() =>
		admitPublicationCandidate(admissionInput([releasePullRequest({ mergeCommit: "c".repeat(40) })])),
	).toThrow("github.sha")
})

test("publication candidate admission rejects unsupported merge modes", () => {
	expect(() =>
		admitPublicationCandidate(admissionInput([releasePullRequest({ mergeMode: "squash" })])),
	).toThrow("merge mode")
})

test("publication candidate admission rejects an existing version tag", () => {
	expect(() =>
		admitPublicationCandidate({ ...admissionInput(), tagExists: true }),
	).toThrow("must be absent before proof")
})

test("publication candidate admission rejects paths outside the release projection", () => {
	expect(() =>
		admitPublicationCandidate(
			admissionInput([releasePullRequest({ changedFiles: [...allowedProjection, "README.md"] })]),
		),
	).toThrow("allowed release projection")
})

test("publication candidate admission accepts the bootstrap manifest and changelog subset", () => {
	const changedFiles = [".github/.release-please-manifest.json", "CHANGELOG.md"]
	expect(
		admitPublicationCandidate(
			admissionInput([
				releasePullRequest({
					changedFiles,
					changedFileStatuses: changedFiles.map(() => "modified"),
				}),
			]),
		),
	).toMatchObject({ version: "0.1.0", tag: "v0.1.0" })
})

test("publication candidate admission rejects an unsupported file status", () => {
	expect(() =>
		admitPublicationCandidate(
			admissionInput([
				releasePullRequest({
					changedFileStatuses: allowedProjection.map((_, index) =>
						index === 0 ? "added" : "modified",
					),
				}),
			]),
		),
	).toThrow("unsupported file status")
})

test("publication candidate admission rejects a rebound candidate record", () => {
	const priorRecord = admitPublicationCandidate(admissionInput())
	expect(() =>
		admitPublicationCandidate({
			...admissionInput([
				releasePullRequest({ automationIdentity: "release-please[bot]" }),
			]),
			expectedAutomationIdentities: ["github-actions[bot]", "release-please[bot]"],
			priorRecord,
		}),
	).toThrow("candidate record is rebound")
})

test("publication candidate admission permits idempotent reuse of the identical record", () => {
	const priorRecord = admitPublicationCandidate(admissionInput())
	expect(admitPublicationCandidate({ ...admissionInput(), priorRecord })).toEqual(priorRecord)
})

test("publication candidate admission ignores persisted JSON key order", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	const persisted = {
		version: candidate.version,
		tag: candidate.tag,
		repository: candidate.repository,
		projectionDigest: candidate.projectionDigest,
		pullRequest: candidate.pullRequest,
		mergeCommit: candidate.mergeCommit,
		expectedTagState: candidate.expectedTagState,
		baseBranch: candidate.baseBranch,
		automationIdentity: candidate.automationIdentity,
	}

	expect(admitPublicationCandidate({ ...admissionInput(), priorRecord: persisted })).toEqual(candidate)
})

test.each([
	["maintain", "\n  maintain:\n"],
	["compatibility", "\n  compatibility:\n"],
	["release", "\n  release:\n"],
] as const)("release validation fails closed without the %s job boundary", (_job, marker) => {
	const temporaryRoot = copyRepository()
	const workflowPath = join(temporaryRoot, ".github", "workflows", "release.yml")
	writeFileSync(workflowPath, readFileSync(workflowPath, "utf8").replace(marker, "\n  renamed-job:\n"))

	const result = validate(temporaryRoot)

	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("job boundary")
})

test("AE3: publication binding agrees on candidate, immutable tag, package, release, and manifest", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	expect(
		validatePublicationBinding({
			candidate,
			tag: "v0.1.0",
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
			releaseTargetSha: "a".repeat(40),
			checksums: {
				repository: "https://github.com/myagentdojo/agent-plugin-template",
				sourceCommit: "a".repeat(40),
				tag: "v0.1.0",
				version: "0.1.0",
			},
		}),
	).toEqual(candidate)
})

test("publication binding rejects an artifact proven from SHA A under a tag for SHA B", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	expect(() =>
		validatePublicationBinding({
			candidate,
			tag: "v0.1.0",
			tagSha: "c".repeat(40),
			manifestVersion: "0.1.0",
			releaseTargetSha: "a".repeat(40),
			checksums: {
				repository: "https://github.com/myagentdojo/agent-plugin-template",
				sourceCommit: "a".repeat(40),
				tag: "v0.1.0",
				version: "0.1.0",
			},
		}),
	).toThrow("tag target")
})

test("publication binding rejects a lookalike repository on another host", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	expect(() =>
		validatePublicationBinding({
			candidate,
			tag: "v0.1.0",
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
			releaseTargetSha: "a".repeat(40),
			checksums: {
				repository: "https://evil.example/myagentdojo/agent-plugin-template",
				sourceCommit: "a".repeat(40),
				tag: "v0.1.0",
				version: "0.1.0",
			},
		}),
	).toThrow("GitHub repository")
})

test("manual repair requires the original publication candidate record", () => {
	const candidate = admitPublicationCandidate(admissionInput())
	expect(
		validateRepairCandidateBinding({
			candidate,
			repository: "myagentdojo/agent-plugin-template",
			expectedBaseBranch: "main",
			expectedAutomationIdentities: ["github-actions[bot]"],
			trustedCandidate: releasePullRequest(),
			tag: "v0.1.0",
			checkoutSha: "a".repeat(40),
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
			releaseTargetSha: "a".repeat(40),
		}),
	).toEqual({ tag: "v0.1.0", commit: "a".repeat(40), version: "0.1.0" })

	expect(() =>
		validateRepairCandidateBinding({
			candidate,
			repository: "myagentdojo/agent-plugin-template",
			expectedBaseBranch: "main",
			expectedAutomationIdentities: ["github-actions[bot]"],
			trustedCandidate: releasePullRequest(),
			tag: "v0.1.0",
			checkoutSha: "c".repeat(40),
			tagSha: "c".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("publication candidate")
})

test("manual repair rejects a forged tag record against GitHub-derived provenance", () => {
	const forged = {
		...admitPublicationCandidate(admissionInput()),
		projectionDigest: "c".repeat(64),
	}

	expect(() =>
		validateRepairCandidateBinding({
			candidate: forged,
			repository: "myagentdojo/agent-plugin-template",
			expectedBaseBranch: "main",
			expectedAutomationIdentities: ["github-actions[bot]"],
			trustedCandidate: releasePullRequest(),
			tag: "v0.1.0",
			checkoutSha: "a".repeat(40),
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("rebound")
})

test("manual repair rejects malformed tag-carried candidate records", () => {
	const candidate = { ...admitPublicationCandidate(admissionInput()), unexpected: true }

	expect(() => parsePublicationCandidateRecord(candidate)).toThrow("record shape")
})

test("manual repair rejects a missing tag", () => {
	expect(() =>
		validateRepairBinding({
			tag: "",
			checkoutSha: "a".repeat(40),
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("tag is required")
})

test("manual repair rejects a tag target unequal to checkout SHA", () => {
	expect(() =>
		validateRepairBinding({
			tag: "v0.1.0",
			checkoutSha: "a".repeat(40),
			tagSha: "b".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("tag target")
})

test("AE4: manual repair rejects tag v0.2.0 with manifest 0.1.0 before mutation", () => {
	expect(() =>
		validateRepairBinding({
			tag: "v0.2.0",
			checkoutSha: "a".repeat(40),
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("manifest version")
})

test("manual repair rejects a Release targeting another SHA", () => {
	expect(() =>
		validateRepairBinding({
			tag: "v0.1.0",
			checkoutSha: "a".repeat(40),
			tagSha: "a".repeat(40),
			manifestVersion: "0.1.0",
			releaseTargetSha: "b".repeat(40),
		}),
	).toThrow("Release target")
})

test("manual repair CLI emits one bound JSON result", () => {
	const temporaryRoot = copyRepository()
	const sha = "a".repeat(40)
	const candidatePath = join(temporaryRoot, "candidate.json")
	const trustedCandidatePath = join(temporaryRoot, "trusted-candidate.json")
	writeFileSync(candidatePath, `${JSON.stringify(admitPublicationCandidate(admissionInput()))}\n`)
	writeFileSync(trustedCandidatePath, `${JSON.stringify(releasePullRequest())}\n`)
	const result = validateWithArguments(temporaryRoot, [
		"--repair",
		"--candidate",
		candidatePath,
		"--trusted-candidate",
		trustedCandidatePath,
		"--repository",
		"myagentdojo/agent-plugin-template",
		"--expected-base-branch",
		"main",
		"--expected-automation-login",
		"github-actions[bot]",
		"--tag",
		"v0.1.0",
		"--checkout-sha",
		sha,
		"--tag-sha",
		sha,
		"--release-target-sha",
		sha,
		"--json",
	])
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		mode: "repair",
		tag: "v0.1.0",
		repair: { tag: "v0.1.0", commit: sha, version: "0.1.0" },
	})
})

test("manual repair CLI fails closed without a persisted publication candidate", () => {
	const sha = "a".repeat(40)
	const result = validateWithArguments(root, [
		"--repair",
		"--tag",
		"v0.1.0",
		"--checkout-sha",
		sha,
		"--tag-sha",
		sha,
		"--json",
	])

	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("publication candidate record is required")
})
