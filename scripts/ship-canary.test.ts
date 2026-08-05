import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	CanaryError,
	PUBLISHING_SYSTEM_PATHS,
	admitCandidateRef,
	bindTransportIdentity,
	candidateRefForSource,
	classifyPublishingSystemChanges,
	qualifyTargets,
	type CandidateInstallEvidence,
	type Target,
} from "./ship-canary"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([".claude", ".dev", ".git", ".worktrees", "dist", "node_modules"])

function executable(path: string, contents: string): void {
	writeFileSync(path, contents)
	chmodSync(path, 0o755)
}

function canaryFixture(): { temporaryRoot: string; fakeBin: string; log: string } {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-plugin-template-canary-"))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	const initialized = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--author",
			"My Agent Dojo",
			"--repository",
			"https://github.com/myagentdojo/dojo-hello",
			"--force",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)

	const fakeBin = join(temporaryRoot, ".test-bin")
	const log = join(temporaryRoot, "commands.log")
	mkdirSync(fakeBin)
	executable(
		join(fakeBin, "gh"),
		`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo myagentdojo; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "create" ]; then printf 'gh-create %s\n' "$*" >> "$FAKE_LOG"; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
	if [ "$FAKE_MISSING_REPO" = "1" ]; then exit 44; fi
	if [ "$FAKE_WRONG_VISIBILITY" = "1" ]; then echo PRIVATE; exit 0; fi
  case "$3" in
    *public-canary) echo PUBLIC ;;
    *private-canary) echo PRIVATE ;;
    *) exit 44 ;;
  esac
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
	if [ "$FAKE_HOSTED_FAILURE" = "1" ]; then echo '[{"databaseId":303,"status":"completed","conclusion":"failure","url":"https://github.com/failure/run/303"}]'; exit 0; fi
  case "$4" in
    *public-canary) echo '[{"databaseId":101,"status":"completed","conclusion":"success","url":"https://github.com/public/run/101"}]' ;;
    *private-canary) echo '[{"databaseId":202,"status":"completed","conclusion":"success","url":"https://github.com/private/run/202"}]' ;;
    *) exit 45 ;;
  esac
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 90
`,
	)
	executable(
		join(fakeBin, "ssh"),
		`#!/bin/sh
printf "Hi %s! You've successfully authenticated, but GitHub does not provide shell access.\n" "\${FAKE_TRANSPORT_IDENTITY:-myagentdojo}" >&2
exit 1
`,
	)
	executable(
		join(fakeBin, "git"),
		`#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo "\${FAKE_ORIGIN:-git@github-myagentdojo:myagentdojo/dojo-hello.git}"; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then exit 0; fi
if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then printf 'protocol=https\nhost=github.com\nusername=%s\npassword=fake\n' "\${FAKE_TRANSPORT_IDENTITY:-myagentdojo}"; exit 0; fi
if [ "$1" = "ls-remote" ]; then
	if [ "$FAKE_EXISTING_CANDIDATE" = "same" ]; then printf '0123456789abcdef0123456789abcdef01234567\t%s\n' "$4"; fi
	if [ "$FAKE_EXISTING_CANDIDATE" = "different" ]; then printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t%s\n' "$4"; fi
	exit 0
fi
if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then exit 0; fi
if [ "$1" = "push" ]; then
	printf '%s\n' "$*" >> "$FAKE_LOG"
	if [ "$FAKE_PUSH_FAIL" = "1" ]; then exit 1; fi
	exit 0
fi
echo "unexpected git command: $*" >&2
exit 91
`,
	)
	return { temporaryRoot, fakeBin, log }
}

function runCanary(
	fixture: ReturnType<typeof canaryFixture>,
	mode: "--dry-run" | "--execute",
	extraEnvironment: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "ship:canary", "--", mode, "--json"],
		cwd: fixture.temporaryRoot,
		env: {
			...process.env,
			...extraEnvironment,
			FAKE_LOG: fixture.log,
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("canary dry-run proves identity, visibility, and source without publishing", () => {
	const result = runCanary(canaryFixture(), "--dry-run")

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "preview",
		sideEffects: "none",
		identity: "myagentdojo",
		transportIdentity: { kind: "ssh", identity: "myagentdojo", host: "github-myagentdojo" },
		source: {
			ref: "origin/main",
			sha: "0123456789abcdef0123456789abcdef01234567",
		},
		targets: [
			{
				repository: "myagentdojo/dojo-hello-public-canary",
				visibility: "PUBLIC",
				candidateRef: "refs/heads/candidate/0123456789abcdef0123456789abcdef01234567",
			},
			{
				repository: "myagentdojo/dojo-hello-private-canary",
				visibility: "PRIVATE",
				candidateRef: "refs/heads/candidate/0123456789abcdef0123456789abcdef01234567",
			},
		],
	})
})

test("publishing-system paths require both hosted canaries and report every trigger", () => {
	expect(PUBLISHING_SYSTEM_PATHS).toEqual([
		"scripts/package.ts",
		"scripts/release-validate.ts",
		"scripts/release-impact.ts",
		"scripts/repository-readiness.ts",
		"scripts/prove-distribution.ts",
		"scripts/prove-harness-install.ts",
		"scripts/ship-canary.ts",
		"scripts/plugin-config.ts",
		"scripts/plugin-files.ts",
		"scripts/init.ts",
		".github/workflows/release.yml",
		".github/workflows/plugin-ci.yml",
		".github/workflows/pull-request-title.yml",
		".github/release-please-config.json",
	])
	const changedPaths = [
		"scripts/package.ts",
		"scripts/release-validate.ts",
		"scripts/release-impact.ts",
		"scripts/init.ts",
		"scripts/plugin-config.ts",
		"scripts/plugin-files.ts",
		"scripts/prove-harness-install.ts",
		"scripts/ship-canary.ts",
	]

	expect(classifyPublishingSystemChanges(changedPaths)).toEqual({
		required: true,
		triggeringPaths: changedPaths,
	})
})

test("recipient payload-only paths keep hosted canaries optional", () => {
	expect(
		classifyPublishingSystemChanges([
			"plugin/.claude-plugin/plugin.json",
			"plugin/runtime/hello-world.js",
			"runtime/src/hello-world.ts",
		]),
	).toEqual({ required: false, triggeringPaths: [] })
})

test("divergent PR heads receive distinct immutable candidate refs", () => {
	const first = "1".repeat(40)
	const second = "2".repeat(40)

	expect(candidateRefForSource(first)).toBe(`refs/heads/candidate/${first}`)
	expect(candidateRefForSource(second)).toBe(`refs/heads/candidate/${second}`)
	expect(candidateRefForSource(first)).not.toBe(candidateRefForSource(second))
})

test("candidate retry accepts only the same commit at the immutable ref", () => {
	const sourceSha = "1".repeat(40)
	const candidateRef = candidateRefForSource(sourceSha)

	expect(admitCandidateRef(candidateRef, sourceSha, sourceSha)).toEqual({
		candidateRef,
		state: "current",
	})
	expect(() => admitCandidateRef(candidateRef, sourceSha, "2".repeat(40))).toThrow(
		"immutable candidate ref",
	)
	try {
		admitCandidateRef(candidateRef, sourceSha, "2".repeat(40))
	} catch (error) {
		expect(error).toBeInstanceOf(CanaryError)
		expect((error as CanaryError).nextAction).toContain("never rewrite history")
		expect((error as CanaryError).retrySafe).toBe(false)
	}
})

test("remote candidate retry reports current or immutable conflict without rewriting", () => {
	const current = runCanary(canaryFixture(), "--dry-run", {
		FAKE_EXISTING_CANDIDATE: "same",
	})
	expect(current.exitCode).toBe(0)
	expect(JSON.parse(current.stdout.toString()).targets[0]).toMatchObject({
		candidateState: "current",
		headSha: "0123456789abcdef0123456789abcdef01234567",
	})

	const conflict = runCanary(canaryFixture(), "--dry-run", {
		FAKE_EXISTING_CANDIDATE: "different",
	})
	expect(conflict.exitCode).toBe(1)
	expect(JSON.parse(conflict.stdout.toString())).toMatchObject({
		category: "candidate_ref_conflict",
		retrySafe: false,
	})
})

test("transport identity mismatch fails before repository mutation", async () => {
	const fixture = canaryFixture()
	const result = runCanary(fixture, "--execute", { FAKE_TRANSPORT_IDENTITY: "nathanvale" })

	expect(result.exitCode).toBe(1)
	const failure = JSON.parse(result.stdout.toString().trim())
	expect(failure).toMatchObject({
		ok: false,
		category: "transport_identity_mismatch",
		retrySafe: false,
	})
	expect(failure.runId).toBeString()
	expect(await Bun.file(fixture.log).exists()).toBe(false)
})

test("SSH and HTTPS transport identity bind independently from gh identity", () => {
	expect(bindTransportIdentity("myagentdojo", "myagentdojo", "myagentdojo", "ssh")).toEqual({
		kind: "ssh",
		identity: "myagentdojo",
	})
	expect(bindTransportIdentity("myagentdojo", "myagentdojo", "myagentdojo", "https")).toEqual({
		kind: "https",
		identity: "myagentdojo",
	})
	expect(() =>
		bindTransportIdentity("myagentdojo", "nathanvale", "myagentdojo", "https"),
	).toThrow("Git transport identity")
})

test("HTTPS preflight binds the credential-helper username without publishing", () => {
	const result = runCanary(canaryFixture(), "--dry-run", {
		FAKE_ORIGIN: "https://github.com/myagentdojo/dojo-hello.git",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		transportIdentity: {
			kind: "https",
			identity: "myagentdojo",
			host: "github.com",
		},
	})
})

function targets(sourceSha: string): Target[] {
	const candidateRef = candidateRefForSource(sourceSha)
	return [
		{
			repository: "myagentdojo/public-canary",
			visibility: "PUBLIC",
			remote: "git@example.invalid:myagentdojo/public-canary.git",
			exists: true,
			candidateRef,
			candidateState: "missing",
		},
		{
			repository: "myagentdojo/private-canary",
			visibility: "PRIVATE",
			remote: "git@example.invalid:myagentdojo/private-canary.git",
			exists: true,
			candidateRef,
			candidateState: "missing",
		},
	]
}

function installEvidence(target: Target, sourceSha: string): CandidateInstallEvidence {
	return {
		repository: target.repository,
		candidateRef: target.candidateRef,
		checkoutSha: sourceSha,
		manifestVersion: "0.1.0",
		claude: {
			mode: "native-local-marketplace",
			version: "0.1.0",
			cachedPayloadMatches: true,
		},
		codex: {
			mode: "native-local-marketplace",
			version: "0.1.0",
			cachedPayloadMatches: true,
		},
	}
}

test("public and private candidates pass hosted proof then native cache comparison", async () => {
	const sourceSha = "1".repeat(40)
	const calls: string[] = []
	const result = await qualifyTargets(targets(sourceSha), sourceSha, {
		publish: (target) => calls.push(`publish:${target.visibility}`),
		hostedProof: async (target) => {
			calls.push(`hosted:${target.visibility}`)
			return {
				repository: target.repository,
				databaseId: target.visibility === "PUBLIC" ? 101 : 202,
				conclusion: "success",
				url: `https://example.invalid/${target.visibility}`,
			}
		},
		install: (target) => {
			calls.push(`install:${target.visibility}`)
			return installEvidence(target, sourceSha)
		},
	})

	expect(result).toMatchObject({
		runs: [
			{ repository: "myagentdojo/public-canary", conclusion: "success" },
			{ repository: "myagentdojo/private-canary", conclusion: "success" },
		],
		installs: [
			{ repository: "myagentdojo/public-canary", checkoutSha: sourceSha },
			{ repository: "myagentdojo/private-canary", checkoutSha: sourceSha },
		],
	})
	expect(calls).toEqual([
		"publish:PUBLIC",
		"publish:PRIVATE",
		"hosted:PUBLIC",
		"hosted:PRIVATE",
		"install:PUBLIC",
		"install:PRIVATE",
	])
	expect(JSON.stringify(result).toLowerCase()).not.toContain("universal-directory")
})

test("repository, visibility, hosted CI, and install failures carry non-rewriting repairs", async () => {
	const missing = runCanary(canaryFixture(), "--dry-run", { FAKE_MISSING_REPO: "1" })
	expect(missing.exitCode).toBe(0)
	expect(JSON.parse(missing.stdout.toString()).targets[0].repairAction).toContain("create")

	const visibility = runCanary(canaryFixture(), "--dry-run", {
		FAKE_WRONG_VISIBILITY: "1",
	})
	expect(visibility.exitCode).toBe(1)
	expect(JSON.parse(visibility.stdout.toString())).toMatchObject({
		category: "visibility_mismatch",
		retrySafe: false,
	})

	const sourceSha = "1".repeat(40)
	const hostedFailure = new CanaryError(
		"hosted_failure",
		"hosted proof failed",
		"inspect the hosted run; never rewrite history",
	)
	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, {
			publish: () => {},
			hostedProof: async () => {
				throw hostedFailure
			},
			install: (target) => installEvidence(target, sourceSha),
		}),
	).rejects.toBe(hostedFailure)
	expect(hostedFailure.nextAction).toContain("never rewrite history")

	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, {
			publish: () => {},
			hostedProof: async (target) => ({
				repository: target.repository,
				databaseId: 1,
				conclusion: "success",
				url: "https://example.invalid/run/1",
			}),
			install: (target) => ({
				...installEvidence(target, sourceSha),
				codex: { ...installEvidence(target, sourceSha).codex, cachedPayloadMatches: false },
			}),
		}),
	).rejects.toMatchObject({
		category: "install_mismatch",
		retrySafe: false,
	})
})

test("workflow gates publishing-system PRs and candidate branches without recipient fan-out", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "plugin-ci.yml"), "utf8")

	expect(workflow).toContain("candidate/**")
	expect(workflow).toContain("canary-classification")
	expect(workflow).toContain("hosted-canaries")
	expect(workflow).toContain("CANARY_GH_TOKEN")
	expect(workflow).toContain("CANARY_SSH_PRIVATE_KEY")
	expect(workflow).toContain("environment: hosted-canary-qualification")
	expect(workflow).toContain("needs.canary-classification.outputs.required == 'true'")
	expect(workflow).toContain("Hosted canaries not required")
})
