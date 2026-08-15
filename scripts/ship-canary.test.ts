import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, spyOn, test } from "bun:test"

import type { CommandOutput, CommandRunOptions, CommandRunner } from "./command-runner"
import {
	CanaryError,
	PUBLISHING_SYSTEM_PATHS,
	admitCandidateRef,
	bindTransportIdentity,
	bindCandidateQualificationLineage,
	bindTrustedPrivateRun,
	candidateRefForSource,
	classifyCanaryChanges,
	classifyPublishingSystemChanges,
	createQualificationDependencies,
	createSanitizedPublicCandidate,
	preflight,
	qualifyTargets,
	runCanary,
	validateLineageManifestVersion,
	type CandidateInstallEvidence,
	type ClassifyOptions,
	type PublishOptions,
	type QualificationDependencies,
	type Target,
} from "./ship-canary"

const root = resolve(import.meta.dir, "..")
const sourceSha = "0123456789abcdef0123456789abcdef01234567"
const publicCandidateSha = "cccccccccccccccccccccccccccccccccccccccc"

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

test("public canary process → renders help without touching hosted systems", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "scripts/ship-canary.ts", "--help"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stdout.toString()).toContain("--classify")
	expect(result.stdout.toString()).toContain("--execute")
	expect(result.stderr.toString()).toBe("")
})

test("public canary process → keeps JSON usage failures on stdout with exit 2", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "scripts/ship-canary.ts", "--dry-run", "--execute", "--json"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(2)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "usage",
		retrySafe: true,
	})
	expect(result.stderr.toString()).toBe("")
})

test("public canary process → renders a successful human classification", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"scripts/ship-canary.ts",
			"--classify",
			"--base",
			"HEAD",
			"--head",
			"HEAD",
		],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stdout.toString()).toBe("Hosted canaries not required.\n")
	expect(result.stderr.toString()).toBe("")
})

test("public canary process → renders a successful JSON classification", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"scripts/ship-canary.ts",
			"--classify",
			"--base",
			"HEAD",
			"--head",
			"HEAD",
			"--json",
		],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toEqual({
		ok: true,
		action: "classified",
		sideEffects: "none",
		base: "HEAD",
		head: "HEAD",
		changedPaths: [],
		canaries: { required: false, triggeringPaths: [] },
		hermeticProof: "required",
	})
	expect(result.stderr.toString()).toBe("")
})

interface CanaryCommandScenario {
	diffPaths?: string[]
	origin?: string
	transportIdentity?: string
	httpsServerIdentity?: string
	missingRepository?: boolean
	wrongVisibility?: boolean
	hostedFailure?: boolean
	hostedTimeout?: boolean
	untrackedDistribution?: boolean
	ignoredDistribution?: boolean
	pushFailure?: boolean
	pushRace?: "same" | "different"
	existingCandidate?: "same" | "different"
}

interface RecordedCommand {
	command: string[]
	options: CommandRunOptions
}

const HTTPS_HELPER_PASSWORD = "fake"

class RecordingCommandRunner implements CommandRunner {
	readonly commands: RecordedCommand[] = []
	private pushAttempted = false

	constructor(private readonly scenario: CanaryCommandScenario = {}) {}

	run(commandValue: readonly string[], options: CommandRunOptions = {}): CommandOutput {
		const command = [...commandValue]
		this.commands.push({
			command,
			options: {
				...options,
				environment: options.environment && { ...options.environment },
			},
		})
		const output = (stdout = "", exitCode = 0, stderr = ""): CommandOutput => {
			const trim = options.trimOutput ?? true
			return {
				exitCode,
				stdout: trim ? stdout.trim() : stdout,
				stderr: trim ? stderr.trim() : stderr,
			}
		}

		if (command[0] === "gh" && command[1] === "api" && command[2] === "user") {
			return output(
				options.environment?.GH_TOKEN === HTTPS_HELPER_PASSWORD
					? (this.scenario.httpsServerIdentity ?? "myagentdojo")
					: "myagentdojo",
			)
		}
		if (command[0] === "gh" && command[1] === "repo" && command[2] === "create") return output()
		if (command[0] === "gh" && command[1] === "repo" && command[2] === "view") {
			if (this.scenario.missingRepository) return output("", 44)
			if (this.scenario.wrongVisibility) return output("PRIVATE")
			if (command[3]?.includes("public-canary")) return output("PUBLIC")
			if (command[3]?.includes("private-canary")) return output("PRIVATE")
			return output("", 44)
		}
		if (command[0] === "gh" && command[1] === "run" && command[2] === "list") {
			if (this.scenario.hostedTimeout) return output("", 124, "timed out")
			if (this.scenario.hostedFailure) {
				return output(
					'[{"databaseId":303,"status":"completed","conclusion":"failure","url":"https://github.com/failure/run/303"}]',
				)
			}
			const databaseId = command[4]?.includes("public-canary") ? 101 : 202
			return output(
				JSON.stringify([
					{
						databaseId,
						status: "completed",
						conclusion: "success",
						url: `https://github.com/run/${databaseId}`,
					},
				]),
			)
		}
		if (command[0] === "ssh") {
			return output(
				"",
				1,
				`Hi ${this.scenario.transportIdentity ?? "myagentdojo"}! You've successfully authenticated, but GitHub does not provide shell access.`,
			)
		}
		if (command[0] === "git" && command[1] === "credential" && command[2] === "fill") {
			return output(
				`protocol=https\nhost=github.com\nusername=myagentdojo\npassword=${HTTPS_HELPER_PASSWORD}\n`,
			)
		}
		if (
			command[0] === "git" &&
			command[1] === "-c" &&
			command[2] === "core.quotePath=false" &&
			command[3] === "diff"
		) {
			const paths = this.scenario.diffPaths ?? []
			return output(paths.length > 0 ? `${paths.join("\0")}\0` : "")
		}
		if (command[0] === "git" && command[1] === "remote" && command[2] === "get-url") {
			return output(
				this.scenario.origin ?? "git@github-myagentdojo:myagentdojo/dojo-hello.git",
			)
		}
		if (command[0] === "git" && command[1] === "rev-parse" && command[2] === "--verify") {
			return output(sourceSha)
		}
		if (command[0] === "git" && command[1] === "status" && command[2] === "--porcelain") {
			return output(
				command[3] === "--untracked-files=all" && this.scenario.untrackedDistribution
					? "?? plugin/injected.js"
					: "",
			)
		}
		if (command[0] === "git" && command[1] === "ls-files") {
			return output(this.scenario.ignoredDistribution ? "plugin/ignored-secret.txt\0" : "")
		}
		if (command[0] === "git" && command[1] === "init") return output()
		if (command[0] === "git" && command[1] === "add") return output()
		if (command[0] === "git" && command[1] === "write-tree") return output("b".repeat(40))
		if (command[0] === "git" && command[1] === "commit-tree") return output(publicCandidateSha)
		if (command[0] === "git" && command[1] === "ls-remote") {
			const expected = command[3]?.includes("public-canary") ? publicCandidateSha : sourceSha
			const state = this.pushAttempted ? this.scenario.pushRace : this.scenario.existingCandidate
			if (state === "same") return output(`${expected}\t${command[4]}`)
			if (state === "different") return output(`${"a".repeat(40)}\t${command[4]}`)
			return output()
		}
		if (command[0] === "git" && command[1] === "push") {
			this.pushAttempted = true
			return output(
				"",
				this.scenario.pushFailure ? 1 : 0,
				this.scenario.pushFailure ? "rejected" : "",
			)
		}
		throw new Error(`unexpected recorded command: ${command.join(" ")}`)
	}
}

interface RecordingCanaryFixture {
	temporaryRoot: string
}

const disposableRoots = new Set<string>()

afterEach(() => {
	for (const directory of disposableRoots) rmSync(directory, { recursive: true, force: true })
	disposableRoots.clear()
})

function recordingCanaryFixture(): RecordingCanaryFixture {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-plugin-template-recording-canary-"))
	disposableRoots.add(temporaryRoot)
	for (const path of ["plugin", ".claude-plugin", ".agents"]) {
		cpSync(join(root, path), join(temporaryRoot, path), { recursive: true })
	}
	const config = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8"))
	config.template = false
	config.name = "dojo-hello"
	config.displayName = "Dojo Hello"
	config.author = { name: "My Agent Dojo" }
	config.repository = "https://github.com/myagentdojo/dojo-hello"
	config.canary = {
		owner: "myagentdojo",
		actor: "myagentdojo",
		publicRepository: "dojo-hello-public-canary",
		privateRepository: "dojo-hello-private-canary",
	}
	writeFileSync(join(temporaryRoot, "plugin.config.json"), `${JSON.stringify(config, null, 2)}\n`)
	return { temporaryRoot }
}

function recordingCanaryEnvironment(
	overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
		GITHUB_RUN_ID: "12345",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_WORKFLOW_REF:
			"myagentdojo/agent-plugin-template/.github/workflows/hosted-canary.yml@refs/heads/main",
		CANARY_QUALIFIED_SOURCE_SHA: sourceSha,
		CANARY_TRUSTED_WORKFLOW_SHA: "1".repeat(40),
		...overrides,
	}
}

function recordingPublishOptions(sourceRoot: string, execute = false): PublishOptions {
	return {
		mode: "publish",
		ref: "origin/main",
		dryRun: !execute,
		execute,
		json: true,
		sourceRoot,
	}
}

function runRecordingPreflight(
	fixture: RecordingCanaryFixture,
	scenario: CanaryCommandScenario = {},
	environment: NodeJS.ProcessEnv = recordingCanaryEnvironment(),
	trustedRoot = fixture.temporaryRoot,
): {
	evidence: ReturnType<typeof preflight>
	runner: RecordingCommandRunner
	dependencies: ReturnType<typeof createQualificationDependencies>
} {
	const runner = new RecordingCommandRunner(scenario)
	const dependencies = createQualificationDependencies(runner, environment, trustedRoot)
	const evidence = preflight(recordingPublishOptions(fixture.temporaryRoot), dependencies)
	disposableRoots.add(evidence.temporaryRoot)
	return { evidence, runner, dependencies }
}

function testQualificationDependencies(
	overrides: Pick<QualificationDependencies, "publish" | "hostedProof" | "install">,
): QualificationDependencies {
	return {
		...createQualificationDependencies(
			new RecordingCommandRunner(),
			recordingCanaryEnvironment(),
			root,
		),
		...overrides,
	}
}

test("canary dry-run → renders identity, visibility, and source without publishing", async () => {
	const fixture = recordingCanaryFixture()
	const runner = new RecordingCommandRunner()
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment(),
		fixture.temporaryRoot,
	)
	const messages: string[] = []
	const log = spyOn(console, "log").mockImplementation((...values) => {
		messages.push(values.map(String).join(" "))
	})
	try {
		await runCanary(
			[
				"--dry-run",
				"--source-root",
				fixture.temporaryRoot,
				"--ref",
				"origin/main",
				"--json",
			],
			"test-run-id",
			dependencies,
		)
	} finally {
		log.mockRestore()
	}

	expect(messages).toHaveLength(1)
	expect(JSON.parse(messages[0] ?? "")).toMatchObject({
		ok: true,
		action: "preview",
		runId: "test-run-id",
		sideEffects: "none",
		identity: "myagentdojo",
		transportIdentity: { kind: "ssh", identity: "myagentdojo", host: "github-myagentdojo" },
		source: { ref: "origin/main", sha: sourceSha },
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
	expect(runner.commands.some((record) => record.command[1] === "push")).toBe(false)
})

test("SSH identity proof reuses the old trusted workflow known-hosts option", () => {
	const { runner } = runRecordingPreflight(
		recordingCanaryFixture(),
		{},
		recordingCanaryEnvironment({
		GIT_SSH_COMMAND:
			"ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/canary-known-hosts",
		}),
	)

	const ssh = runner.commands.find((record) => record.command[0] === "ssh")
	expect(ssh?.command).toContain("UserKnownHostsFile=/tmp/canary-known-hosts")
	expect(ssh?.command).toContain("GlobalKnownHostsFile=/dev/null")
})

test("SSH identity proof receives the injected environment", () => {
	const environment = recordingCanaryEnvironment({ CANARY_SENTINEL: "ssh-injected" })
	const { runner } = runRecordingPreflight(recordingCanaryFixture(), {}, environment)

	const ssh = runner.commands.find((record) => record.command[0] === "ssh")
	expect(ssh?.options.environment).toEqual(environment)
})

test("SSH identity proof binds the explicit hosted key without agent fallback", () => {
	const identityFile = "/tmp/canary-identity"
	const knownHostsFile = "/tmp/canary-known-hosts"
	const { runner } = runRecordingPreflight(
		recordingCanaryFixture(),
		{},
		recordingCanaryEnvironment({
		CANARY_SSH_IDENTITY_FILE: identityFile,
		CANARY_SSH_KNOWN_HOSTS_FILE: knownHostsFile,
		GIT_SSH_COMMAND: `ssh -F /dev/null -o IdentityAgent=none -i ${identityFile} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile} -o GlobalKnownHostsFile=/dev/null`,
		}),
	)

	const ssh = runner.commands.find((record) => record.command[0] === "ssh")
	expect(ssh?.command).toEqual(
		expect.arrayContaining([
			"-F",
			"/dev/null",
			"IdentityAgent=none",
			"-i",
			identityFile,
			"IdentitiesOnly=yes",
			`UserKnownHostsFile=${knownHostsFile}`,
		]),
	)
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
	const runner = new RecordingCommandRunner({ diffPaths: ["scripts/package.ts"] })
	const options: ClassifyOptions = { mode: "classify", base: "base", head: "head", json: true }
	const result = classifyCanaryChanges(options, runner, root)

	expect(result).toMatchObject({
		changedPaths: ["scripts/package.ts"],
		canaries: { required: true, triggeringPaths: ["scripts/package.ts"] },
	})
	expect(runner.commands).toHaveLength(1)
	expect(runner.commands[0]).toMatchObject({
		command: [
			"git",
			"-c",
			"core.quotePath=false",
			"diff",
			"--name-only",
			"-z",
			"--diff-filter=ACMRTD",
			"--no-renames",
			"base...head",
		],
		options: { workingDirectory: root, trimOutput: false },
	})
})

test("classification receives the injected environment", async () => {
	const environment = recordingCanaryEnvironment({ CANARY_SENTINEL: "classification-injected" })
	const runner = new RecordingCommandRunner()
	const dependencies = createQualificationDependencies(runner, environment, root)
	const log = spyOn(console, "log").mockImplementation(() => undefined)
	try {
		await runCanary(
			["--classify", "--base", "base", "--head", "head", "--json"],
			"test-run-id",
			dependencies,
		)
	} finally {
		log.mockRestore()
	}

	const classification = runner.commands.find(
		(record) => record.command[0] === "git" && record.command.includes("diff"),
	)
	expect(classification?.options.environment).toEqual(environment)
})

test("classify includes a publishing path renamed into documentation", () => {
	const result = classifyCanaryChanges(
		{ mode: "classify", base: "base", head: "head", json: true },
		new RecordingCommandRunner({ diffPaths: ["docs/package.ts", "scripts/package.ts"] }),
		root,
	)

	expect(result).toMatchObject({
		changedPaths: ["docs/package.ts", "scripts/package.ts"],
		canaries: { required: true, triggeringPaths: ["scripts/package.ts"] },
	})
})

test("classify preserves non-ASCII and newline Git path names", () => {
	const result = classifyCanaryChanges(
		{ mode: "classify", base: "base", head: "head", json: true },
		new RecordingCommandRunner({ diffPaths: ["scripts/café.ts", "scripts/line\nbreak.ts"] }),
		root,
	)

	expect(result).toMatchObject({
		changedPaths: ["scripts/café.ts", "scripts/line\nbreak.ts"],
		canaries: {
			required: true,
			triggeringPaths: ["scripts/café.ts", "scripts/line\nbreak.ts"],
		},
	})
})

test("candidate config cannot redirect trusted canary targets", () => {
	const fixture = recordingCanaryFixture()
	const dependencies = createQualificationDependencies(
		new RecordingCommandRunner(),
		recordingCanaryEnvironment(),
		root,
	)

	expect(() => preflight(recordingPublishOptions(fixture.temporaryRoot), dependencies)).toThrow(
		expect.objectContaining({
		category: "canary_target_mismatch",
		retrySafe: false,
		}),
	)
})

test("trusted template base admits exact first-consumer canary targets", () => {
	const candidate = recordingCanaryFixture()
	const { evidence } = runRecordingPreflight(
		candidate,
		{},
		recordingCanaryEnvironment({
			GITHUB_REPOSITORY: "myagentdojo/dojo-hello",
			CANARY_HEAD_REPOSITORY: "myagentdojo/dojo-hello",
			GITHUB_WORKFLOW_REF:
				"myagentdojo/dojo-hello/.github/workflows/hosted-canary.yml@refs/heads/main",
		}),
		root,
	)

	expect(evidence).toMatchObject({
		identity: "myagentdojo",
		targets: [
			{ repository: "myagentdojo/dojo-hello-public-canary", visibility: "PUBLIC" },
			{ repository: "myagentdojo/dojo-hello-private-canary", visibility: "PRIVATE" },
		],
	})
})

interface MutableBootstrapCandidate {
	template: boolean
	repository: string
	canary: {
		owner: string
		actor: string
		publicRepository: string
		privateRepository: string
	}
}

test.each([
	[
		"redirected target",
		(config: MutableBootstrapCandidate) => {
			config.canary.publicRepository = "attacker-public-canary"
		},
		{},
	],
	[
		"wrong actor",
		(config: MutableBootstrapCandidate) => {
			config.canary.actor = "another-actor"
		},
		{},
	],
	[
		"wrong repository URL",
		(config: MutableBootstrapCandidate) => {
			config.repository = "https://github.com/myagentdojo/another-repository"
		},
		{},
	],
	[
		"partially initialized candidate",
		(config: MutableBootstrapCandidate) => {
			config.template = true
		},
		{},
	],
	[
		"fork head",
		(_config: MutableBootstrapCandidate) => {},
		{ CANARY_HEAD_REPOSITORY: "fork-owner/dojo-hello" },
	],
])("trusted template bootstrap rejects %s", (_name, mutate, environment) => {
	const candidate = recordingCanaryFixture()
	const candidateConfigPath = join(candidate.temporaryRoot, "plugin.config.json")
	const candidateConfig = JSON.parse(
		readFileSync(candidateConfigPath, "utf8"),
	) as MutableBootstrapCandidate
	mutate(candidateConfig)
	writeFileSync(candidateConfigPath, `${JSON.stringify(candidateConfig, null, 2)}\n`)

	const runner = new RecordingCommandRunner()
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment({
			GITHUB_REPOSITORY: "myagentdojo/dojo-hello",
			CANARY_HEAD_REPOSITORY: "myagentdojo/dojo-hello",
			GITHUB_WORKFLOW_REF:
				"myagentdojo/dojo-hello/.github/workflows/hosted-canary.yml@refs/heads/main",
			...environment,
		}),
		root,
	)

	expect(() => preflight(recordingPublishOptions(candidate.temporaryRoot), dependencies)).toThrow(
		expect.objectContaining({
			category: "canary_target_mismatch",
			retrySafe: false,
		}),
	)
	expect(runner.commands.map((record) => record.command)).toEqual([
		["gh", "api", "user", "--jq", ".login"],
	])
})

test("public publication uses sanitized bytes while private publication uses the source checkout", async () => {
	const candidate = recordingCanaryFixture()
	const { evidence, runner, dependencies } = runRecordingPreflight(
		candidate,
		{ hostedFailure: true },
		recordingCanaryEnvironment({ GH_TOKEN: "fake" }),
	)

	await expect(qualifyTargets(evidence.targets, evidence.sourceSha, dependencies)).rejects.toMatchObject({
		category: "hosted_failure",
	})
	const pushes = runner.commands.filter(
		(record) => record.command[0] === "git" && record.command[1] === "push",
	)
	expect(pushes).toHaveLength(2)
	expect(pushes[0]).toMatchObject({
		command: expect.arrayContaining([
			`${publicCandidateSha}:refs/heads/candidate/${publicCandidateSha}`,
		]),
		options: { workingDirectory: expect.stringContaining("public-canary-candidate-") },
	})
	expect(pushes[1]).toMatchObject({
		command: expect.arrayContaining([`${sourceSha}:refs/heads/candidate/${sourceSha}`]),
		options: { workingDirectory: candidate.temporaryRoot },
	})
	expect(pushes.every((record) => record.options.environment?.GH_TOKEN === "fake")).toBe(true)
})

test("trusted preflight → does not apply the base renderer to candidate-generated files", () => {
	const candidate = recordingCanaryFixture()
	writeFileSync(join(candidate.temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "{}\n")

	const { evidence } = runRecordingPreflight(candidate)

	expect(evidence.targets).toHaveLength(2)
})

test("public candidate rejects untracked distribution files before publication", () => {
	const fixture = recordingCanaryFixture()
	const runner = new RecordingCommandRunner({ untrackedDistribution: true })
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment(),
		fixture.temporaryRoot,
	)

	expect(() => preflight(recordingPublishOptions(fixture.temporaryRoot, true), dependencies)).toThrow(
		"untracked files are present in the public marketplace distribution",
	)
	expect(runner.commands.some((record) => record.command[1] === "push")).toBe(false)
})

test("public candidate rejects an ignored secret before copying checkout bytes", () => {
	const fixture = recordingCanaryFixture()
	const runner = new RecordingCommandRunner({ ignoredDistribution: true })
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment(),
		fixture.temporaryRoot,
	)

	expect(() => preflight(recordingPublishOptions(fixture.temporaryRoot, true), dependencies)).toThrow(
		"ignored files are present in the public marketplace distribution",
	)
	expect(
		runner.commands.find((record) => record.command[1] === "ls-files")?.options.trimOutput,
	).toBe(false)
	expect(runner.commands.some((record) => record.command[1] === "push")).toBe(false)
})

test("hosted polling → bounds a hung network child by the outer deadline", async () => {
	const fixture = recordingCanaryFixture()
	const startedAt = Date.now()
	const environment = recordingCanaryEnvironment({
		CANARY_HOSTED_RUN_DEADLINE_MS: "120",
		CANARY_NETWORK_COMMAND_TIMEOUT_MS: "25",
		CANARY_HOSTED_POLL_DELAY_MS: "5",
		GH_TOKEN: "qualification-token",
	})
	const { evidence, runner, dependencies } = runRecordingPreflight(
		fixture,
		{ hostedTimeout: true },
		environment,
	)

	await expect(qualifyTargets(evidence.targets, evidence.sourceSha, dependencies)).rejects.toMatchObject({
			category: "hosted_timeout",
			message: expect.stringContaining("within 120 milliseconds"),
			retrySafe: false,
		})
	expect(Date.now() - startedAt).toBeLessThan(2000)
	const polls = runner.commands.filter((record) => record.command[1] === "run")
	expect(polls.length).toBeGreaterThan(0)
	for (const poll of polls) {
		expect(poll.options.timeout).toBeDefined()
		expect(poll.options.timeout).toBeLessThanOrEqual(25)
		expect(poll.options.environment).toEqual(environment)
	}
})

test("create-only candidate push → accepts an identical winner but rejects a conflicting race", async () => {
	const same = runRecordingPreflight(recordingCanaryFixture(), {
		pushFailure: true,
		pushRace: "same",
		hostedFailure: true,
	})
	await expect(
		qualifyTargets(same.evidence.targets, same.evidence.sourceSha, same.dependencies),
	).rejects.toMatchObject({ category: "hosted_failure" })

	const different = runRecordingPreflight(recordingCanaryFixture(), {
		pushFailure: true,
		pushRace: "different",
	})
	await expect(
		qualifyTargets(different.evidence.targets, different.evidence.sourceSha, different.dependencies),
	).rejects.toMatchObject({ category: "candidate_ref_conflict" })
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
	const current = runRecordingPreflight(recordingCanaryFixture(), {
		existingCandidate: "same",
	})
	expect(current.evidence.targets[0]).toMatchObject({
		candidateState: "current",
		candidateSha: publicCandidateSha,
		headSha: publicCandidateSha,
	})

	expect(() =>
		runRecordingPreflight(recordingCanaryFixture(), { existingCandidate: "different" }),
	).toThrow("immutable candidate ref")
})

test("transport identity mismatch → fails before repository mutation", () => {
	const fixture = recordingCanaryFixture()
	const runner = new RecordingCommandRunner({ transportIdentity: "nathanvale" })
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment(),
		fixture.temporaryRoot,
	)

	expect(() => preflight(recordingPublishOptions(fixture.temporaryRoot, true), dependencies)).toThrow(
		"Git transport identity",
	)
	expect(runner.commands.some((record) => record.command[1] === "push")).toBe(false)
})

test("canary actor may publish repositories owned by an organization", () => {
	const fixture = recordingCanaryFixture()
	const configPath = join(fixture.temporaryRoot, "plugin.config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8"))
	config.canary.owner = "myagentdojo-org"
	config.canary.actor = "myagentdojo"
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
	const { evidence } = runRecordingPreflight(fixture)

	expect(evidence).toMatchObject({
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
	const { evidence, runner } = runRecordingPreflight(recordingCanaryFixture(), {
		origin: "https://github.com/myagentdojo/dojo-hello.git",
	})

	expect(evidence).toMatchObject({
		transportIdentity: {
			kind: "https",
			identity: "myagentdojo",
			host: "github.com",
		},
	})
	const credential = runner.commands.find(
		(record) => record.command[0] === "git" && record.command[1] === "credential",
	)
	expect(credential?.options.input).toBe(
		"protocol=https\nhost=github.com\npath=myagentdojo/dojo-hello.git\n\n",
	)
	expect(credential?.options.environment?.GIT_TERMINAL_PROMPT).toBe("0")
})

test("HTTPS preflight rejects a helper token owned by another GitHub user", () => {
	const fixture = recordingCanaryFixture()
	const runner = new RecordingCommandRunner({
		origin: "https://github.com/myagentdojo/dojo-hello.git",
		httpsServerIdentity: "nathanvale",
	})
	const dependencies = createQualificationDependencies(
		runner,
		recordingCanaryEnvironment(),
		fixture.temporaryRoot,
	)

	let failure: unknown
	try {
		preflight(recordingPublishOptions(fixture.temporaryRoot), dependencies)
	} catch (error) {
		failure = error
	}
	expect(String(failure)).toContain("Git transport identity")
	expect(String(failure)).not.toContain(HTTPS_HELPER_PASSWORD)
	expect(
		runner.commands.flatMap((record) => [...record.command, record.options.input ?? ""]),
	).not.toContain(expect.stringContaining(HTTPS_HELPER_PASSWORD))
	const tokenCommands = runner.commands.filter((record) =>
		Object.values(record.options.environment ?? {}).includes(HTTPS_HELPER_PASSWORD),
	)
	expect(tokenCommands.map((record) => record.command.slice(0, 3))).toEqual([
		["gh", "api", "user"],
	])
	expect(runner.commands.some((record) => record.command[1] === "push")).toBe(false)
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
	const result = await qualifyTargets(targets(sourceSha), sourceSha, testQualificationDependencies({
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
	}))

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
		qualifyTargets(targets(sourceSha), sourceSha, testQualificationDependencies({
			publish: () => {},
			hostedProof,
			install: (target, candidateSha) => {
				const evidence = installEvidence(target, candidateSha)
				return {
					...evidence,
					lineage: { ...evidence.lineage, installedPayloadHash: "c".repeat(64) },
				}
			},
		})),
	).rejects.toMatchObject({
		category: "qualification_lineage_mismatch",
		retrySafe: false,
	})

	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, testQualificationDependencies({
			publish: () => {},
			hostedProof,
			install: (target, candidateSha) => {
				const evidence = installEvidence(target, candidateSha)
				return {
					...evidence,
					lineage: { ...evidence.lineage, archiveSha256: "not-a-digest" },
				}
			},
		})),
	).rejects.toMatchObject({
		category: "qualification_lineage_invalid",
		retrySafe: false,
	})
})

test("repository, visibility, hosted CI, and install failures carry non-rewriting repairs", async () => {
	const missing = runRecordingPreflight(recordingCanaryFixture(), { missingRepository: true })
	expect(missing.evidence.targets[0].repairAction).toContain("create")

	expect(() =>
		runRecordingPreflight(recordingCanaryFixture(), { wrongVisibility: true }),
	).toThrow("expected PUBLIC")

	const sourceSha = "1".repeat(40)
	const hostedFailure = new CanaryError(
		"hosted_failure",
		"hosted proof failed",
		"inspect the hosted run; never rewrite history",
	)
	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, testQualificationDependencies({
			publish: () => {},
			hostedProof: async () => {
				throw hostedFailure
			},
			install: (target, candidateSha) => installEvidence(target, candidateSha),
		})),
	).rejects.toBe(hostedFailure)
	expect(hostedFailure.nextAction).toContain("never rewrite history")

	await expect(
		qualifyTargets(targets(sourceSha), sourceSha, testQualificationDependencies({
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
		})),
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
	const releaseSetup = readFileSync(join(root, "docs", "release-setup.md"), "utf8")

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
	expect(workflow).toContain(
		"CANARY_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}",
	)
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
	expect(releaseSetup).toContain("token-backed GitHub API identity and SSH Git identity")
	expect(releaseSetup).not.toContain("HTTPS Git identity")
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
