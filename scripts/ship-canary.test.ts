import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	CanaryError,
	PUBLISHING_SYSTEM_PATHS,
	admitCandidateRef,
	bindTransportIdentity,
	bindCandidateQualificationLineage,
	bindTrustedPrivateRun,
	candidateRefForSource,
	classifyPublishingSystemChanges,
	createSanitizedPublicCandidate,
	qualifyTargets,
	validateLineageManifestVersion,
	type CandidateInstallEvidence,
	type Target,
} from "./ship-canary"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([".claude", ".dev", ".git", ".worktrees", "dist", "node_modules"])

test("candidate qualification lineage binds package and installed bytes to one source", () => {
	const sourceCommit = "1".repeat(40)
	const archiveSha256 = "2".repeat(64)
	const payloadInventorySha256 = "3".repeat(64)
	expect(
		bindCandidateQualificationLineage(
			sourceCommit,
			{ sourceCommit, archiveSha256, payloadInventorySha256 },
			payloadInventorySha256,
		),
	).toEqual({
		sourceCommit,
		archiveSha256,
		packagedPayloadHash: payloadInventorySha256,
		installedPayloadHash: payloadInventorySha256,
	})
})

test("candidate qualification lineage rejects a different source or installed payload", () => {
	const sourceCommit = "1".repeat(40)
	const checksums = {
		sourceCommit,
		archiveSha256: "2".repeat(64),
		payloadInventorySha256: "3".repeat(64),
	}
	expect(() =>
		bindCandidateQualificationLineage(
			sourceCommit,
			{ ...checksums, sourceCommit: "4".repeat(40) },
			checksums.payloadInventorySha256,
		),
	).toThrow("source commit")
	expect(() =>
		bindCandidateQualificationLineage(sourceCommit, checksums, "5".repeat(64)),
	).toThrow("installed payload")
})

test.each(["1.2", "01.2.3", "1.2.3/../../escape", `1.2.3+${"a".repeat(64)}`])(
	"lineage packaging rejects unsafe manifest version %s",
	(manifestVersion) => {
		expect(() => validateLineageManifestVersion(manifestVersion)).toThrow(
			"manifest version must be exact semantic versioning and at most 64 characters",
		)
	},
)

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
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  if [ "\${GH_TOKEN:-}" = "fake" ]; then echo "\${FAKE_HTTPS_SERVER_IDENTITY:-myagentdojo}"; else echo myagentdojo; fi
  exit 0
fi
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
	if [ "$FAKE_HOSTED_HANG" = "1" ]; then sleep 10; exit 88; fi
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
if [ -n "\${FAKE_EXPECTED_SSH_KNOWN_HOSTS_FILE:-}" ]; then
  case " $* " in *" -o UserKnownHostsFile=$FAKE_EXPECTED_SSH_KNOWN_HOSTS_FILE "*) ;; *) exit 93 ;; esac
  case " $* " in *" -o GlobalKnownHostsFile=/dev/null "*) ;; *) exit 94 ;; esac
fi
if [ -n "\${FAKE_EXPECTED_SSH_IDENTITY_FILE:-}" ]; then
  case " $* " in *" -F /dev/null "*) ;; *) exit 95 ;; esac
  case " $* " in *" -o IdentityAgent=none "*) ;; *) exit 96 ;; esac
  case " $* " in *" -i $FAKE_EXPECTED_SSH_IDENTITY_FILE "*) ;; *) exit 97 ;; esac
  case " $* " in *" -o IdentitiesOnly=yes "*) ;; *) exit 98 ;; esac
fi
printf "Hi %s! You've successfully authenticated, but GitHub does not provide shell access.\n" "\${FAKE_TRANSPORT_IDENTITY:-myagentdojo}" >&2
exit 1
`,
	)
	executable(
		join(fakeBin, "git"),
		`#!/bin/sh
FAKE_LOG="\${FAKE_LOG:-${log}}"
if [ "$1" = "-c" ] && [ "$2" = "core.quotePath=false" ]; then shift 2; fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo "\${FAKE_ORIGIN:-git@github-myagentdojo:myagentdojo/dojo-hello.git}"; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi
if [ "$1" = "init" ]; then exit 0; fi
if [ "$1" = "add" ]; then exit 0; fi
if [ "$1" = "write-tree" ]; then printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'; exit 0; fi
if [ "$1" = "commit-tree" ]; then printf 'cccccccccccccccccccccccccccccccccccccccc\n'; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then
	if [ "$3" = "--untracked-files=all" ] && [ "$FAKE_UNTRACKED_DISTRIBUTION" = "1" ]; then echo '?? plugin/injected.js'; fi
	exit 0
fi
if [ "$1" = "ls-files" ]; then
	if [ "$FAKE_IGNORED_DISTRIBUTION" = "1" ]; then printf 'plugin/ignored-secret.txt\\0'; fi
	exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "--name-only" ]; then
	if [ "$3" != "-z" ]; then exit 92; fi
	if [ "$4" != "--diff-filter=ACMRTD" ]; then exit 93; fi
	if [ "$5" != "--no-renames" ]; then exit 94; fi
	if [ "$FAKE_RENAME" = "1" ]; then printf 'docs/package.ts\\0scripts/package.ts\\0'; exit 0; fi
	if [ "$FAKE_UNUSUAL_DIFF" = "1" ]; then printf 'scripts/café.ts\\0scripts/line\nbreak.ts\\0'; exit 0; fi
	if [ -n "\${FAKE_DIFF_PATH:-}" ]; then printf '%s\\0' "$FAKE_DIFF_PATH"; fi
	exit 0
fi
if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then printf 'protocol=https\nhost=github.com\nusername=%s\npassword=fake\n' "\${FAKE_TRANSPORT_IDENTITY:-myagentdojo}"; exit 0; fi
if [ "$1" = "ls-remote" ]; then
	case "$3" in *public-canary*) expected=cccccccccccccccccccccccccccccccccccccccc ;; *) expected=0123456789abcdef0123456789abcdef01234567 ;; esac
	if [ "$FAKE_PUSH_RACE" = "same" ] && [ -s "$FAKE_LOG" ]; then printf '%s\t%s\n' "$expected" "$4"; fi
	if [ "$FAKE_PUSH_RACE" = "different" ] && [ -s "$FAKE_LOG" ]; then printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t%s\n' "$4"; fi
	if [ "$FAKE_EXISTING_CANDIDATE" = "same" ]; then printf '%s\t%s\n' "$expected" "$4"; fi
	if [ "$FAKE_EXISTING_CANDIDATE" = "different" ]; then printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t%s\n' "$4"; fi
	exit 0
fi
if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then exit 0; fi
if [ "$1" = "push" ]; then
	printf 'git-push-cwd=%s %s\n' "$(pwd)" "$*" >> "$FAKE_LOG"
	printf 'git-push-gh-token=%s\n' "\${GH_TOKEN:+present}" >> "$FAKE_LOG"
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
			FAKE_LOG: fixture.log,
			GITHUB_ACTIONS: "true",
			GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
			GITHUB_RUN_ID: "12345",
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_WORKFLOW_REF: "myagentdojo/agent-plugin-template/.github/workflows/hosted-canary.yml@refs/heads/main",
			CANARY_QUALIFIED_SOURCE_SHA: "0123456789abcdef0123456789abcdef01234567",
			CANARY_TRUSTED_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
			...extraEnvironment,
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

function runTrustedCanary(
	driverRoot: string,
	driver: ReturnType<typeof canaryFixture>,
	sourceRoot: string,
	mode: "--dry-run" | "--execute",
	extraEnvironment: Record<string, string> = {},
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			join(driverRoot, "scripts", "ship-canary.ts"),
			mode,
			"--source-root",
			sourceRoot,
			"--ref",
			"HEAD",
			"--json",
		],
		cwd: driverRoot,
		env: {
			...process.env,
			FAKE_LOG: driver.log,
			GITHUB_ACTIONS: "true",
			GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
			GITHUB_RUN_ID: "12345",
			GITHUB_SERVER_URL: "https://github.com",
			GITHUB_WORKFLOW_REF: "myagentdojo/agent-plugin-template/.github/workflows/hosted-canary.yml@refs/heads/main",
			CANARY_QUALIFIED_SOURCE_SHA: "0123456789abcdef0123456789abcdef01234567",
			CANARY_TRUSTED_WORKFLOW_SHA: "1111111111111111111111111111111111111111",
			...extraEnvironment,
			PATH: `${driver.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
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
				candidateRef: "refs/heads/candidate/cccccccccccccccccccccccccccccccccccccccc",
				candidateSha: "cccccccccccccccccccccccccccccccccccccccc",
			},
			{
				repository: "myagentdojo/dojo-hello-private-canary",
				visibility: "PRIVATE",
				candidateRef: "refs/heads/candidate/0123456789abcdef0123456789abcdef01234567",
				candidateSha: "0123456789abcdef0123456789abcdef01234567",
			},
		],
	})
	expect(result.stdout.toString()).not.toContain("public-canary-candidate-")
})

test("SSH identity proof reuses the old trusted workflow known-hosts option", () => {
	const result = runCanary(canaryFixture(), "--dry-run", {
		FAKE_EXPECTED_SSH_KNOWN_HOSTS_FILE: "/tmp/canary-known-hosts",
		GIT_SSH_COMMAND:
			"ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/canary-known-hosts",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test("SSH identity proof binds the explicit hosted key without agent fallback", () => {
	const identityFile = "/tmp/canary-identity"
	const knownHostsFile = "/tmp/canary-known-hosts"
	const result = runCanary(canaryFixture(), "--dry-run", {
		CANARY_SSH_IDENTITY_FILE: identityFile,
		CANARY_SSH_KNOWN_HOSTS_FILE: knownHostsFile,
		FAKE_EXPECTED_SSH_IDENTITY_FILE: identityFile,
		FAKE_EXPECTED_SSH_KNOWN_HOSTS_FILE: knownHostsFile,
		GIT_SSH_COMMAND: `ssh -F /dev/null -o IdentityAgent=none -i ${identityFile} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile} -o GlobalKnownHostsFile=/dev/null`,
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test("publishing-system paths require both hosted canaries and report every trigger", () => {
	expect(PUBLISHING_SYSTEM_PATHS).toEqual([
		"package.json",
		"plugin.config.json",
		".github/release-please-config.json",
	])
	const changedPaths = [
		"plugin.config.json",
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

test("new scripts and workflows fail closed into hosted canary qualification", () => {
	const changedPaths = [
		"scripts/build.ts",
		"scripts/generate.ts",
		"scripts/future-publisher.ts",
		".github/workflows/codex-review-gate.yml",
		".github/workflows/future-release.yml",
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

test("classify diff filter includes deleted and type-changed publishing-system paths", () => {
	const fixture = canaryFixture()
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"ship:canary",
			"--",
			"--classify",
			"--base",
			"base",
			"--head",
			"head",
			"--json",
		],
		cwd: fixture.temporaryRoot,
		env: {
			...process.env,
			FAKE_DIFF_PATH: "scripts/package.ts",
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({
		changedPaths: ["scripts/package.ts"],
		canaries: { required: true, triggeringPaths: ["scripts/package.ts"] },
	})
})

test("classify includes a publishing path renamed into documentation", () => {
	const fixture = canaryFixture()
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "ship:canary", "--", "--classify", "--base", "base", "--head", "head", "--json"],
		cwd: fixture.temporaryRoot,
		env: {
			...process.env,
			FAKE_RENAME: "1",
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		changedPaths: ["docs/package.ts", "scripts/package.ts"],
		canaries: { required: true, triggeringPaths: ["scripts/package.ts"] },
	})
})

test("classify preserves non-ASCII and newline Git path names", () => {
	const fixture = canaryFixture()
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "ship:canary", "--", "--classify", "--base", "base", "--head", "head", "--json"],
		cwd: fixture.temporaryRoot,
		env: {
			...process.env,
			FAKE_UNUSUAL_DIFF: "1",
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		changedPaths: ["scripts/café.ts", "scripts/line\nbreak.ts"],
		canaries: {
			required: true,
			triggeringPaths: ["scripts/café.ts", "scripts/line\nbreak.ts"],
		},
	})
})

test("candidate config cannot redirect trusted canary targets", () => {
	const fixture = canaryFixture()
	const result = runTrustedCanary(root, fixture, fixture.temporaryRoot, "--dry-run")

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		category: "canary_target_mismatch",
		retrySafe: false,
	})
})

test("public publication uses sanitized bytes while private publication uses the source checkout", async () => {
	const driver = canaryFixture()
	const candidate = canaryFixture()
	const result = runTrustedCanary(
		driver.temporaryRoot,
		driver,
		candidate.temporaryRoot,
		"--execute",
		{ FAKE_HOSTED_FAILURE: "1", GH_TOKEN: "fake" },
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({ category: "hosted_failure" })
	expect(await Bun.file(driver.log).text()).toContain("public-canary-candidate-")
	expect(await Bun.file(driver.log).text()).toContain(
		"cccccccccccccccccccccccccccccccccccccccc:refs/heads/candidate/cccccccccccccccccccccccccccccccccccccccc",
	)
	expect(await Bun.file(driver.log).text()).toContain(
		`git-push-cwd=${realpathSync(candidate.temporaryRoot)} push`,
	)
	expect(await Bun.file(driver.log).text()).toContain(
		"0123456789abcdef0123456789abcdef01234567:refs/heads/candidate/0123456789abcdef0123456789abcdef01234567",
	)
	expect((await Bun.file(driver.log).text()).match(/git-push-gh-token=present/g)).toHaveLength(2)
})

test("trusted preflight does not apply the base renderer to candidate-generated files", async () => {
	const driver = canaryFixture()
	const candidate = canaryFixture()
	writeFileSync(join(candidate.temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "{}\n")

	const result = runTrustedCanary(
		driver.temporaryRoot,
		driver,
		candidate.temporaryRoot,
		"--execute",
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).not.toMatchObject({ category: "generated_drift" })
	expect(await Bun.file(driver.log).text()).toContain("push")
})

test("public candidate rejects untracked distribution files before publication", () => {
	const fixture = canaryFixture()
	const result = runCanary(fixture, "--execute", { FAKE_UNTRACKED_DISTRIBUTION: "1" })

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		category: "dirty_checkout",
		message: "untracked files are present in the public marketplace distribution",
	})
	expect(existsSync(fixture.log)).toBe(false)
})

test("public candidate rejects an ignored secret before copying checkout bytes", () => {
	const fixture = canaryFixture()
	const result = runCanary(fixture, "--execute", { FAKE_IGNORED_DISTRIBUTION: "1" })

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		category: "dirty_checkout",
		message: "ignored files are present in the public marketplace distribution",
		retrySafe: false,
	})
	expect(existsSync(fixture.log)).toBe(false)
})

test("hosted polling bounds a hung network child by the outer deadline", () => {
	const fixture = canaryFixture()
	const startedAt = Date.now()
	const result = runCanary(fixture, "--execute", {
		FAKE_HOSTED_HANG: "1",
		CANARY_HOSTED_RUN_DEADLINE_MS: "120",
		CANARY_NETWORK_COMMAND_TIMEOUT_MS: "25",
		CANARY_HOSTED_POLL_DELAY_MS: "5",
	})

	expect(result.exitCode).toBe(1)
	expect(Date.now() - startedAt).toBeLessThan(2000)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		category: "hosted_timeout",
		message: expect.stringContaining("within 120 milliseconds"),
		retrySafe: false,
	})
})

test("create-only candidate push accepts an identical winner but rejects a conflicting race", () => {
	const same = runCanary(canaryFixture(), "--execute", {
		FAKE_PUSH_FAIL: "1",
		FAKE_PUSH_RACE: "same",
		FAKE_HOSTED_FAILURE: "1",
	})
	const different = runCanary(canaryFixture(), "--execute", {
		FAKE_PUSH_FAIL: "1",
		FAKE_PUSH_RACE: "different",
	})

	expect(same.exitCode).toBe(1)
	expect(JSON.parse(same.stdout.toString())).toMatchObject({ category: "hosted_failure" })
	expect(different.exitCode).toBe(1)
	expect(JSON.parse(different.stdout.toString())).toMatchObject({
		category: "candidate_ref_conflict",
	})
})

test("divergent PR heads receive distinct immutable candidate refs", () => {
	const first = "1".repeat(40)
	const second = "2".repeat(40)

	expect(candidateRefForSource(first)).toBe(`refs/heads/candidate/${first}`)
	expect(candidateRefForSource(second)).toBe(`refs/heads/candidate/${second}`)
	expect(candidateRefForSource(first)).not.toBe(candidateRefForSource(second))
})

test("sanitized public candidates are deterministic root commits with no repository source", () => {
	const sourceSha = "1".repeat(40)
	const previousGitSshCommand = process.env.GIT_SSH_COMMAND
	const previousIdentityFile = process.env.CANARY_SSH_IDENTITY_FILE
	const gitSshCommand = "ssh -o UserKnownHostsFile=/tmp/canary-known-hosts"
	const identityFile = "/tmp/canary-identity"
	process.env.GIT_SSH_COMMAND = gitSshCommand
	process.env.CANARY_SSH_IDENTITY_FILE = identityFile
	const first = createSanitizedPublicCandidate(root, sourceSha)
	const second = createSanitizedPublicCandidate(root, sourceSha)
	try {
		expect(first.sha).toBe(second.sha)
		expect(first.environment).not.toHaveProperty("CANARY_GH_TOKEN")
		expect(first.environment).not.toHaveProperty("SSH_AUTH_SOCK")
		expect(first.environment.GIT_SSH_COMMAND).toBe(gitSshCommand)
		expect(first.environment.CANARY_SSH_IDENTITY_FILE).toBe(identityFile)
		expect(first.environment).not.toHaveProperty("GH_TOKEN")
		expect(Object.keys(first.environment).sort()).toEqual([
			"CANARY_SSH_IDENTITY_FILE",
			"GIT_AUTHOR_DATE",
			"GIT_AUTHOR_EMAIL",
			"GIT_AUTHOR_NAME",
			"GIT_COMMITTER_DATE",
			"GIT_COMMITTER_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_NOSYSTEM",
			"GIT_CONFIG_SYSTEM",
			"GIT_SSH_COMMAND",
			"HOME",
			"PATH",
		])
		const tree = Bun.spawnSync({
			cmd: ["git", "ls-tree", "-r", "--name-only", first.sha],
			cwd: first.repositoryRoot,
			stdout: "pipe",
			stderr: "pipe",
		})
		expect(tree.exitCode, tree.stderr.toString()).toBe(0)
		const paths = tree.stdout.toString().trim().split("\n")
		expect(paths).toContain(".claude-plugin/marketplace.json")
		expect(paths).toContain(".agents/plugins/marketplace.json")
		expect(paths).toContain(".github/workflows/plugin-ci.yml")
		expect(paths.some((path) => path.startsWith("plugin/"))).toBe(true)
		expect(paths).not.toContain("plugin.config.json")
		expect(paths.some((path) => path.startsWith("scripts/"))).toBe(false)
		expect(paths).not.toContain("README.md")
		const workflow = readFileSync(join(first.repositoryRoot, ".github/workflows/plugin-ci.yml"), "utf8")
		expect(workflow).toContain("name: Prove and package plugin")
		expect(workflow).toContain('branches:\n      - "candidate/**"')
		expect(workflow).toContain("persist-credentials: false")
		expect(workflow).not.toContain("bun run")
		const parents = Bun.spawnSync({
			cmd: ["git", "rev-list", "--parents", "-n", "1", first.sha],
			cwd: first.repositoryRoot,
			stdout: "pipe",
		})
		expect(parents.stdout.toString().trim()).toBe(first.sha)
	} finally {
		if (previousGitSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
		else process.env.GIT_SSH_COMMAND = previousGitSshCommand
		if (previousIdentityFile === undefined) delete process.env.CANARY_SSH_IDENTITY_FILE
		else process.env.CANARY_SSH_IDENTITY_FILE = previousIdentityFile
		rmSync(first.temporaryRoot, { recursive: true, force: true })
		rmSync(second.temporaryRoot, { recursive: true, force: true })
	}
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
		candidateSha: "cccccccccccccccccccccccccccccccccccccccc",
		headSha: "cccccccccccccccccccccccccccccccccccccccc",
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

test("canary actor may publish repositories owned by an organization", () => {
	const fixture = canaryFixture()
	const configPath = join(fixture.temporaryRoot, "plugin.config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8"))
	config.canary.owner = "myagentdojo-org"
	config.canary.actor = "myagentdojo"
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
	const result = runCanary(fixture, "--dry-run")

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		identity: "myagentdojo",
		transportIdentity: { identity: "myagentdojo" },
		targets: [
			{ repository: "myagentdojo-org/dojo-hello-public-canary" },
			{ repository: "myagentdojo-org/dojo-hello-private-canary" },
		],
	})
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

test("HTTPS preflight authenticates the exact credential-helper token without publishing", () => {
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

test("HTTPS preflight rejects a helper token owned by another GitHub user", () => {
	const result = runCanary(canaryFixture(), "--dry-run", {
		FAKE_ORIGIN: "https://github.com/myagentdojo/dojo-hello.git",
		FAKE_HTTPS_SERVER_IDENTITY: "nathanvale",
	})

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		category: "transport_identity_mismatch",
		retrySafe: false,
	})
	expect(result.stdout.toString()).not.toContain("password=fake")
})

function targets(sourceSha: string): Target[] {
	const publicSha = "2".repeat(40)
	return [
		{
			repository: "myagentdojo/public-canary",
			visibility: "PUBLIC",
			remote: "git@example.invalid:myagentdojo/public-canary.git",
			exists: true,
			candidateRef: candidateRefForSource(publicSha),
			candidateState: "missing",
			candidateSha: publicSha,
			publicationRoot: "/tmp/public-canary",
		},
		{
			repository: "myagentdojo/private-canary",
			visibility: "PRIVATE",
			remote: "git@example.invalid:myagentdojo/private-canary.git",
			exists: true,
			candidateRef: candidateRefForSource(sourceSha),
			candidateState: "missing",
			candidateSha: sourceSha,
			publicationRoot: "/tmp/private-canary",
		},
	]
}

function installEvidence(target: Target, candidateSha: string): CandidateInstallEvidence {
	return {
		repository: target.repository,
		candidateRef: target.candidateRef,
		checkoutSha: candidateSha,
		manifestVersion: "0.1.0",
		claude: {
			mode: "native-hosted-marketplace",
			version: "0.1.0",
			cachedPayloadMatches: true,
		},
		codex: {
			mode: "native-hosted-marketplace",
			version: "0.1.0",
			cachedPayloadMatches: true,
		},
		lineage: {
			sourceCommit: candidateSha,
			archiveSha256: "a".repeat(64),
			packagedPayloadHash: "b".repeat(64),
			installedPayloadHash: "b".repeat(64),
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
				sourceSha: target.candidateSha,
				workflowSha: "3".repeat(40),
				authority: target.visibility === "PUBLIC" ? "candidate-sanitized-workflow" : "protected-trusted-workflow",
			}
		},
		install: (target, candidateSha) => {
			calls.push(`install:${target.visibility}`)
			return installEvidence(target, candidateSha)
		},
	})

	expect(result).toMatchObject({
		runs: [
			{ repository: "myagentdojo/public-canary", conclusion: "success" },
			{ repository: "myagentdojo/private-canary", conclusion: "success" },
		],
		installs: [
			{
				repository: "myagentdojo/public-canary",
				checkoutSha: "2".repeat(40),
				lineage: {
					sourceCommit: "2".repeat(40),
					archiveSha256: "a".repeat(64),
					packagedPayloadHash: "b".repeat(64),
					installedPayloadHash: "b".repeat(64),
				},
			},
			{
				repository: "myagentdojo/private-canary",
				checkoutSha: sourceSha,
				lineage: {
					sourceCommit: sourceSha,
					archiveSha256: "a".repeat(64),
					packagedPayloadHash: "b".repeat(64),
					installedPayloadHash: "b".repeat(64),
				},
			},
		],
	})
	expect(calls).toEqual([
		"publish:PUBLIC",
		"publish:PRIVATE",
		"hosted:PUBLIC",
		"install:PUBLIC",
		"install:PRIVATE",
		"hosted:PRIVATE",
	])
	expect(JSON.stringify(result).toLowerCase()).not.toContain("universal-directory")
})

test("qualification binds candidate lineage and rejects unbound install evidence", async () => {
	const sourceSha = "1".repeat(40)
	const hostedProof = async (target: Target) => ({
		repository: target.repository,
		databaseId: 1,
		conclusion: "success",
		url: "https://example.invalid/run/1",
		sourceSha: target.candidateSha,
		workflowSha: "3".repeat(40),
		authority:
			target.visibility === "PUBLIC"
				? ("candidate-sanitized-workflow" as const)
				: ("protected-trusted-workflow" as const),
	})

	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, {
			publish: () => {},
			hostedProof,
			install: (target, candidateSha) => {
				const evidence = installEvidence(target, candidateSha)
				return {
					...evidence,
					lineage: { ...evidence.lineage, installedPayloadHash: "c".repeat(64) },
				}
			},
		}),
	).rejects.toMatchObject({
		category: "qualification_lineage_mismatch",
		retrySafe: false,
	})

	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, {
			publish: () => {},
			hostedProof,
			install: (target, candidateSha) => {
				const evidence = installEvidence(target, candidateSha)
				return {
					...evidence,
					lineage: { ...evidence.lineage, archiveSha256: "not-a-digest" },
				}
			},
		}),
	).rejects.toMatchObject({
		category: "qualification_lineage_invalid",
		retrySafe: false,
	})
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
			install: (target, candidateSha) => installEvidence(target, candidateSha),
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
				sourceSha: target.candidateSha,
				workflowSha: "3".repeat(40),
				authority: target.visibility === "PUBLIC" ? "candidate-sanitized-workflow" : "protected-trusted-workflow",
			}),
			install: (target, candidateSha) => ({
				...installEvidence(target, candidateSha),
				codex: { ...installEvidence(target, candidateSha).codex, cachedPayloadMatches: false },
			}),
		}),
	).rejects.toMatchObject({
		category: "install_mismatch",
		retrySafe: false,
	})
})

test("private qualification rejects candidate-controlled workflow receipts", () => {
	const sourceSha = "1".repeat(40)
	const privateTarget = targets(sourceSha)[1]
	const environment = {
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
		GITHUB_RUN_ID: "12345",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_WORKFLOW_REF: "myagentdojo/agent-plugin-template/.github/workflows/hosted-canary.yml@refs/heads/main",
		CANARY_TRUSTED_WORKFLOW_SHA: "2".repeat(40),
		CANARY_QUALIFIED_SOURCE_SHA: "9".repeat(40),
	}

	expect(() => bindTrustedPrivateRun(privateTarget, sourceSha, environment)).toThrow(
		"not bound to the protected hosted-canary workflow and source commit",
	)
	expect(
		bindTrustedPrivateRun(privateTarget, sourceSha, {
			...environment,
			CANARY_QUALIFIED_SOURCE_SHA: sourceSha,
		}),
	).toMatchObject({
		repository: privateTarget.repository,
		databaseId: 12345,
		sourceSha,
		workflowSha: "2".repeat(40),
		authority: "protected-trusted-workflow",
	})
})

test("untrusted PR workflow always reports without canary credentials", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "plugin-ci.yml"), "utf8")

	expect(workflow).toContain("pull_request:")
	expect(workflow).not.toContain("pull_request:\n    paths:")
	expect(workflow).toContain("candidate/**")
	expect(workflow).not.toContain("CANARY_GH_TOKEN")
	expect(workflow).not.toContain("CANARY_SSH_PRIVATE_KEY")
	expect(workflow).not.toContain("environment: hosted-canary-qualification")
	expect(workflow).toContain("bun run generate:check")
	expect(workflow).toContain("@anthropic-ai/claude-code@2.1.222")
	expect(workflow).toContain("@openai/codex@0.146.1")
	expect(workflow).toContain("bun run prove:harness-install -- --require-native")
})

test("privileged canary workflow executes trusted code and treats the PR checkout as data", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "hosted-canary.yml"), "utf8")
	const readme = readFileSync(join(root, "README.md"), "utf8")

	expect(workflow).toContain("pull_request_target:")
	expect(workflow).not.toContain("checks: write")
	expect(workflow).not.toContain("/check-runs")
	expect(workflow).toContain("  result:\n    name: Hosted public and private Git canaries\n    if: always()")
	expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}")
	expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}")
	expect(workflow).toContain("HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}")
	expect(workflow).toContain('git fetch --no-tags "https://github.com/${HEAD_REPOSITORY}.git" "$HEAD_SHA"')
	expect(workflow).not.toContain('git fetch --no-tags origin "$HEAD_SHA"')
	expect(workflow).toContain("path: candidate")
	expect(workflow).toContain("persist-credentials: false")
	expect(workflow).toContain("--source-root candidate")
	expect(workflow).toMatch(
		/Check out candidate as data[\s\S]*?persist-credentials: false[\s\S]*?fetch-depth: 0/,
	)
	expect(workflow).not.toContain("bun run generate:check")
	expect(workflow).toContain("@anthropic-ai/claude-code@2.1.222")
	expect(workflow).toContain("@openai/codex@0.146.1")
	expect(workflow).toContain("environment: hosted-canary-qualification")
	expect(workflow).toContain("CANARY_QUALIFIED_SOURCE_SHA: ${{ github.event.pull_request.head.sha }}")
	expect(workflow).toContain("CANARY_TRUSTED_WORKFLOW_SHA: ${{ github.event.pull_request.base.sha }}")
	expect(workflow).toContain("GH_TOKEN: ${{ secrets.CANARY_GH_TOKEN }}")
	expect(workflow).toContain("CANARY_SSH_KNOWN_HOSTS: ${{ secrets.CANARY_SSH_KNOWN_HOSTS }}")
	expect(workflow).toContain("CANARY_SSH_PRIVATE_KEY: ${{ secrets.CANARY_SSH_PRIVATE_KEY }}")
	expect(workflow).toContain('export GIT_CONFIG_NOSYSTEM="1"')
	expect(workflow).toContain('export CANARY_SSH_KNOWN_HOSTS_FILE="$known_hosts"')
	expect(workflow).toContain("-o GlobalKnownHostsFile=/dev/null")
	expect(workflow).toContain('identity_file="$credential_root/id_ed25519"')
	expect(workflow).toContain('printf \'%s\\n\' "$CANARY_SSH_PRIVATE_KEY" > "$identity_file"')
	expect(workflow).toContain('chmod 600 "$identity_file"')
	expect(workflow).toContain('export CANARY_SSH_IDENTITY_FILE="$identity_file"')
	expect(workflow).toContain("-F /dev/null")
	expect(workflow).toContain("-o IdentityAgent=none")
	expect(workflow).toContain("-i $identity_file")
	expect(workflow).not.toContain("ssh-add")
	expect(workflow).not.toContain("ssh-agent")
	expect(workflow).toContain('unset CANARY_SSH_KNOWN_HOSTS CANARY_SSH_PRIVATE_KEY')
	expect(workflow).toContain('rm -rf "$credential_root"')
	expect(workflow).not.toContain("gh auth setup-git")
	expect(workflow).toContain('git remote set-url origin "git@github.com:${GITHUB_REPOSITORY}.git"')
	expect(workflow).not.toContain("CHECK_RUN_ID")
	expect(readme).toContain("token-backed GitHub API identity and SSH Git identity")
	expect(readme).not.toContain("HTTPS Git identity")
})

test("hosted canary workflow gives fork authors a same-repository qualification path", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "hosted-canary.yml"), "utf8")

	expect(workflow).toContain(
		"SAME_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name == github.repository }}",
	)
	expect(workflow).toContain('if [ "$CLASSIFICATION_RESULT" != "success" ]; then')
	expect(workflow).toContain(
		'elif [ "$CANARIES_REQUIRED" = "true" ] && [ "$SAME_REPOSITORY" != "true" ]; then',
	)
	expect(workflow).toContain(
		"Hosted canaries were required for this fork pull request. A maintainer must run qualification from a same-repository branch.",
	)
})
