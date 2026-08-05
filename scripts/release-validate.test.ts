import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	admitPublicationCandidate,
	validatePublicationBinding,
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
	const pluginConfig = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	writeFileSync(
		join(temporaryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ ".": pluginConfig.version }, null, 2)}\n`,
	)
	writeFileSync(
		join(temporaryRoot, "CHANGELOG.md"),
		`# Changelog\n\n## ${pluginConfig.version}\n\nInitial release.\n`,
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		releaseState: "released",
		version: pluginConfig.version,
	})
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
	const pluginConfig = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	writeFileSync(
		join(temporaryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ ".": pluginConfig.version }, null, 2)}\n`,
	)
	writeFileSync(
		join(temporaryRoot, "CHANGELOG.md"),
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
	expect(workflow).toContain("git tag \"$RELEASE_TAG\" \"$CANDIDATE_SHA\"")
	expect(workflow).toContain("git push origin \"refs/tags/${RELEASE_TAG}\"")
	expect(workflow).toContain("remote_tag_sha")
	expect(workflow).toContain("gh release create")
	expect(workflow).toContain("--verify-tag")
	expect(workflow).toContain("gh release upload")
	expect(workflow).toContain("*.checksums.json")
	expect(workflow).toContain("replace_mismatched_assets")
	expect(workflow).toContain("gh release download")
	expect(workflow).toContain("sha256sum")
	expect(workflow).toContain("bun run release:validate -- --repair")
	const maintainJob = workflow.slice(
		workflow.indexOf("\n  maintain:\n"),
		workflow.indexOf("\n  compatibility:\n"),
	)
	expect(maintainJob).toContain("persist-credentials: false")
	expect(maintainJob).toContain("id: bootstrap-version")
	expect(maintainJob).toContain("jq 'length' .github/.release-please-manifest.json")
	expect(maintainJob).toContain('release_as="0.1.0"')
	expect(maintainJob).toContain("token: ${{ secrets.RELEASE_PLEASE_TOKEN }}")
	expect(maintainJob).not.toContain("secrets.GITHUB_TOKEN")
	expect(maintainJob).toContain("release-as: ${{ steps.bootstrap-version.outputs.release_as }}")
	expect(finalReleaseJob).toContain("publication-candidate-${CANDIDATE_SHA}")
	expect(finalReleaseJob).toContain("    needs:\n      - resolve\n      - package\n")
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
			tag: "v0.1.0",
			checkoutSha: "c".repeat(40),
			tagSha: "c".repeat(40),
			manifestVersion: "0.1.0",
		}),
	).toThrow("publication candidate")
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
	writeFileSync(candidatePath, `${JSON.stringify(admitPublicationCandidate(admissionInput()))}\n`)
	const result = validateWithArguments(temporaryRoot, [
		"--repair",
		"--candidate",
		candidatePath,
		"--repository",
		"myagentdojo/agent-plugin-template",
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
