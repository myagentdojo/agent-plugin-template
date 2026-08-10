import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"

import {
	admitGitTransport,
	assertReplacementAdmission,
	copyMarketplaceDistribution,
	hostedMarketplaceSources,
	nativeHarnessEnvironment,
	promoteNativeQualificationEvidence,
	proveHarnessInstall,
	proveInstalledCapabilityEvidence,
	redactTemporaryEvidencePath,
	resolveCleanSourceCommit,
	resolveCandidatePayloadCommit,
	runtimeClosureEvidence,
} from "./prove-harness-install"
import {
	CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
	type PluginConfig,
	writeGeneratedFiles,
} from "./plugin-config"

const root = resolve(import.meta.dir, "..")
let proof: ReturnType<typeof proveHarnessInstall>
const claudeNativeTest = Bun.which("claude") ? test : test.skip
const codexNativeTest = Bun.which("codex") ? test : test.skip

function nativeQualificationSummary(client: "claude" | "codex") {
	const hash = (value: string) => value.repeat(64)
	return {
		schema: "native-capability-qualification-v1",
		client,
		platform: "macos",
		receiptSha256: hash("1"),
		sourceCandidateSha: "a".repeat(40),
		archiveSha256: hash("2"),
		packagedPayloadHash: hash("3"),
		installedPayloadHash: hash("3"),
		derivedPayloadHash: hash("4"),
		conclusions: {
			discovery: "proved",
			uiIdentity: "proved",
			skillSeededNativeDelegation: "proved",
			hostOwnedLifecycleEvidence: "proved",
			sessionStart: "proved",
			cleanStop: "silent",
			driftContinuation: "proved",
			reentry: "silent",
			hooksFallback: "proved",
			exactDefinitionTrust: client === "codex" ? "proved" : "not-applicable",
		},
		evidence: {
			discoverySha256: hash("5"),
			uiIdentitySha256: hash("6"),
			delegationLifecycleSha256: hash("7"),
			sessionStartSha256: hash("8"),
			cleanStopSha256: hash("9"),
			driftSha256: hash("a"),
			reentrySha256: hash("b"),
			hooksFallbackSha256: hash("c"),
			...(client === "codex" ? { exactDefinitionTrustSha256: hash("d") } : {}),
		},
	}
}

test("fresh-native qualification promotion accepts only candidate-bound bounded evidence", () => {
	const summary = nativeQualificationSummary("codex")
	expect(
		promoteNativeQualificationEvidence(summary, {
			client: "codex",
			sourceCommit: summary.sourceCandidateSha,
			archiveSha256: summary.archiveSha256,
			packagedPayloadHash: summary.packagedPayloadHash,
			installedPayloadHash: summary.installedPayloadHash,
		}),
	).toEqual(summary)

	expect(() =>
		promoteNativeQualificationEvidence(
			{ ...summary, rawSession: { transcript: "must stay private" } },
			{
				client: "codex",
				sourceCommit: summary.sourceCandidateSha,
				archiveSha256: summary.archiveSha256,
				packagedPayloadHash: summary.packagedPayloadHash,
				installedPayloadHash: summary.installedPayloadHash,
			},
		),
	).toThrow("bounded summary and evidence hashes")
})

test("a bounded failed qualification records evidence without promoting native claims", () => {
	const summary = nativeQualificationSummary("codex")
	const failed = {
		...summary,
		conclusions: { ...summary.conclusions, sessionStart: "failed" },
	}
	expect(
		promoteNativeQualificationEvidence(failed, {
			client: "codex",
			sourceCommit: summary.sourceCandidateSha,
			archiveSha256: summary.archiveSha256,
			packagedPayloadHash: summary.packagedPayloadHash,
			installedPayloadHash: summary.installedPayloadHash,
		}),
	).toEqual(failed)
})

test("fresh-native qualification promotion rejects unbound or incomplete claims", () => {
	const summary = nativeQualificationSummary("claude")
	const expected = {
		client: "claude" as const,
		sourceCommit: summary.sourceCandidateSha,
		archiveSha256: summary.archiveSha256,
		packagedPayloadHash: summary.packagedPayloadHash,
		installedPayloadHash: summary.installedPayloadHash,
	}

	expect(() =>
		promoteNativeQualificationEvidence(
			{ ...summary, sourceCandidateSha: "f".repeat(40) },
			expected,
		),
	).toThrow("candidate lineage")
	expect(() =>
		promoteNativeQualificationEvidence(
			{ ...summary, archiveSha256: "e".repeat(64) },
			expected,
		),
	).toThrow("candidate lineage")
	expect(() =>
		promoteNativeQualificationEvidence(
			{ ...summary, derivedPayloadHash: summary.packagedPayloadHash },
			expected,
		),
	).toThrow("distinct derived payload hash")
	expect(() =>
		promoteNativeQualificationEvidence(
			{
				...summary,
				conclusions: { ...summary.conclusions, exactDefinitionTrust: "proved" },
			},
			expected,
		),
	).toThrow("exact-definition trust")
})

test("installed evidence promotes native claims only with a validated fresh-client summary", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "installed-native-promotion-"))
	const pluginRoot = join(temporaryRoot, "plugin")
	try {
		cpSync(join(root, "plugin"), pluginRoot, { recursive: true })
		const candidateCommit = "a".repeat(40)
		const payloadHash = runtimeClosureEvidence(pluginRoot).payloadHash
		const base = nativeQualificationSummary("claude")
		const receipt = {
			...base,
			sourceCandidateSha: candidateCommit,
			packagedPayloadHash: payloadHash,
			installedPayloadHash: payloadHash,
		}

		expect(
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				candidateCommit,
				payloadHash,
				{
					summary: receipt,
					lineage: {
						sourceCommit: candidateCommit,
						archiveSha256: receipt.archiveSha256,
						packagedPayloadHash: payloadHash,
						installedPayloadHash: payloadHash,
					},
				},
			),
		).toMatchObject({
			currentSessionHook: "unknown",
			nativeActivation: "proved",
			externalCandidateQualification: "proved",
			nativeDelegation: "proved",
			nativeQualification: { status: "proved", receipt },
		})
		expect(
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				candidateCommit,
				payloadHash,
				undefined,
				true,
			),
		).toMatchObject({
			currentSessionHook: "proved",
			nativeActivation: "not-proved",
			externalCandidateQualification: "unknown",
			nativeDelegation: "not-proved",
			nativeQualification: { status: "not-proved", receipt: null },
		})
		const failedReceipt = {
			...receipt,
			conclusions: { ...receipt.conclusions, cleanStop: "failed" },
		}
		expect(
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				candidateCommit,
				payloadHash,
				{
					summary: failedReceipt,
					lineage: {
						sourceCommit: candidateCommit,
						archiveSha256: failedReceipt.archiveSha256,
						packagedPayloadHash: payloadHash,
						installedPayloadHash: payloadHash,
					},
				},
			),
		).toMatchObject({
			currentSessionHook: "unknown",
			nativeActivation: "not-proved",
			externalCandidateQualification: "unknown",
			nativeDelegation: "not-proved",
			nativeQualification: { status: "failed", receipt: failedReceipt },
		})
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("source-bound native receipts reject dirty checkout bytes", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "native-receipt-source-"))
	try {
		const environment = {
			...process.env,
			GIT_AUTHOR_NAME: "Receipt Test",
			GIT_AUTHOR_EMAIL: "receipt@example.invalid",
			GIT_COMMITTER_NAME: "Receipt Test",
			GIT_COMMITTER_EMAIL: "receipt@example.invalid",
		}
		mkdirSync(join(fixtureRoot, "plugin"))
		writeFileSync(join(fixtureRoot, "plugin", "payload.txt"), "clean\n")
		for (const command of [
			["git", "init", "--quiet"],
			["git", "add", "plugin/payload.txt"],
			["git", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture"],
		]) {
			const result = Bun.spawnSync({ cmd: command, cwd: fixtureRoot, env: environment })
			expect(result.exitCode).toBe(0)
		}
		expect(resolveCleanSourceCommit(fixtureRoot)).toMatch(/^[a-f0-9]{40}$/)
		writeFileSync(join(fixtureRoot, "plugin", "payload.txt"), "dirty\n")
		expect(() => resolveCleanSourceCommit(fixtureRoot)).toThrow(/requires clean candidate payload sources/)
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true })
	}
})

test("candidate payload binding permits tooling changes but rejects plugin drift", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "candidate-payload-source-"))
	try {
		const environment = {
			...process.env,
			GIT_AUTHOR_NAME: "Candidate Test",
			GIT_AUTHOR_EMAIL: "candidate@example.invalid",
			GIT_COMMITTER_NAME: "Candidate Test",
			GIT_COMMITTER_EMAIL: "candidate@example.invalid",
		}
		mkdirSync(join(fixtureRoot, "plugin"))
		writeFileSync(join(fixtureRoot, "plugin", "payload.txt"), "clean\n")
		writeFileSync(join(fixtureRoot, "tooling.txt"), "clean\n")
		for (const command of [
			["git", "init", "--quiet"],
			["git", "add", "plugin/payload.txt", "tooling.txt"],
			["git", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture"],
		]) {
			expect(Bun.spawnSync({ cmd: command, cwd: fixtureRoot, env: environment }).exitCode).toBe(0)
		}
		writeFileSync(join(fixtureRoot, "tooling.txt"), "changed\n")
		expect(resolveCandidatePayloadCommit(fixtureRoot)).toMatch(/^[a-f0-9]{40}$/)
		writeFileSync(join(fixtureRoot, "plugin", "payload.txt"), "changed\n")
		expect(() => resolveCandidatePayloadCommit(fixtureRoot)).toThrow("plugin payload bytes")
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true })
	}
})

beforeAll(() => {
	proof = proveHarnessInstall(root)
}, 60_000)

afterAll(() => {
	if (proof?.temporaryRoot) rmSync(proof.temporaryRoot, { recursive: true, force: true })
})

test("public marketplace distribution excludes repository source and configuration", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "public-marketplace-distribution-"))
	try {
		copyMarketplaceDistribution(root, temporaryRoot)
		expect(existsSync(join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"))).toBe(true)
		expect(existsSync(join(temporaryRoot, ".claude-plugin", "marketplace.json"))).toBe(true)
		expect(existsSync(join(temporaryRoot, ".agents", "plugins", "marketplace.json"))).toBe(true)
		expect(existsSync(join(temporaryRoot, "plugin.config.json"))).toBe(false)
		expect(existsSync(join(temporaryRoot, "scripts"))).toBe(false)
		expect(existsSync(join(temporaryRoot, "README.md"))).toBe(false)
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("tagged payload installs byte-for-byte into isolated Claude and Codex caches", () => {
	expect(proof.ok).toBe(true)
	expect(proof.preflight.resolvedSha).toMatch(/^[a-f0-9]{40}$/)
	expect(proof.claude.inventory).toEqual(proof.preflight.inventory)
	expect(proof.codex.inventory).toEqual(proof.preflight.inventory)
	for (const relativePath of proof.preflight.inventory) {
		const taggedBytes = readFileSync(`${proof.preflight.checkoutRoot}/plugin/${relativePath}`)
		expect(readFileSync(`${proof.claude.activeCachePath}/${relativePath}`)).toEqual(taggedBytes)
		expect(readFileSync(`${proof.codex.installedPath}/${relativePath}`)).toEqual(taggedBytes)
	}
})

test("both isolated harness installs report the tagged manifest version", () => {
	expect(proof.claude.version).toBe(proof.preflight.manifestVersion)
	expect(proof.codex.version).toBe(proof.preflight.manifestVersion)
	expect(proof.targetPreflight.requestedRef).not.toBe(proof.preflight.requestedRef)
	expect(proof.restorationPreflight).toEqual(proof.preflight)
	expect(proof.versionAgreement).toBe(true)
})

test("automated install evidence binds bytes without claiming native activation", () => {
	const head = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: root, stdout: "pipe" })
	expect(proof.capabilityEvidence.candidateCommit).toBe(head.stdout.toString().trim())
	expect(proof.capabilityEvidence.fixtureCommit).toBe(proof.preflight.resolvedSha)
	expect(proof.capabilityEvidence.candidatePayloadHash).toMatch(/^[a-f0-9]{64}$/)
	for (const client of ["claude", "codex"] as const) {
		expect(proof.capabilityEvidence.clients[client]).toEqual({
			candidateCommit: proof.capabilityEvidence.candidateCommit,
			candidatePayloadHash: proof.capabilityEvidence.candidatePayloadHash,
			installedPayloadHash: proof.capabilityEvidence.candidatePayloadHash,
			declarationHealth: "healthy",
			directHandlerHealth: "healthy",
			fixtureState: "matched",
			currentSessionHook: "unknown",
			nativeActivation: "not-proved",
			externalCandidateQualification: "unknown",
			nativeDelegation: "not-proved",
			nativeQualification: { status: "not-proved", receipt: null },
			portableSkillsWithoutHooks: [
				"hello-world",
				"skill-a",
				"skill-b",
				"runtime-custody",
				"capability-tour",
			],
		})
	}
	expect(proof.codex).not.toHaveProperty("activation")
})

test.each([
	{
		path: "assets/logo.svg",
		tamper: (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("tampered\n")]),
		expected: "installed payload hash differs from the candidate payload",
	},
	{
		path: "skills/capability-tour/references/capability-reviewer.md",
		tamper: (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("tampered\n")]),
		expected: "installed payload hash differs from the candidate payload",
	},
	{
		path: "hooks/claude/hooks.json",
		tamper: () => Buffer.from("{}\n"),
		expected: "installed declaration bytes do not match the capability contract",
	},
	{
		path: "hooks/fixture/lifecycle-mechanics-proof.generated.json",
		tamper: (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("tampered\n")]),
		expected: "installed lifecycle mechanics proof fixture differs",
	},
] as const)("installed capability evidence rejects tampered $path bytes", ({ path, tamper, expected }) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "installed-capability-tamper-"))
	const pluginRoot = join(temporaryRoot, "plugin")
	try {
		cpSync(join(root, "plugin"), pluginRoot, { recursive: true })
		const candidatePayloadHash = runtimeClosureEvidence(pluginRoot).payloadHash
		const absolutePath = join(pluginRoot, path)
		writeFileSync(absolutePath, tamper(readFileSync(absolutePath)))
		expect(() =>
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				"a".repeat(40),
				candidatePayloadHash,
			),
		).toThrow(expected)
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("installed payload hash is validated before the candidate handler executes", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "installed-capability-handler-tamper-"))
	const pluginRoot = join(temporaryRoot, "plugin")
	const marker = join(temporaryRoot, "handler-ran")
	try {
		cpSync(join(root, "plugin"), pluginRoot, { recursive: true })
		const candidatePayloadHash = runtimeClosureEvidence(pluginRoot).payloadHash
		writeFileSync(
			join(pluginRoot, "hooks", "native-capability-hook"),
			`#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`,
		)
		expect(() =>
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				"a".repeat(40),
				candidatePayloadHash,
			),
		).toThrow("installed payload hash differs from the candidate payload")
		expect(existsSync(marker)).toBe(false)
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("installed capability evidence rejects a catalogued model-only tour", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "installed-capability-catalog-"))
	const pluginRoot = join(temporaryRoot, "plugin")
	try {
		cpSync(join(root, "plugin"), pluginRoot, { recursive: true })
		const catalogPath = join(pluginRoot, "runtime", "skill-catalog.sh")
		writeFileSync(catalogPath, `${readFileSync(catalogPath, "utf8")}\n\tcapability-tour)\n`)
		expect(() =>
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"claude",
				"a".repeat(40),
				runtimeClosureEvidence(pluginRoot).payloadHash,
			),
		).toThrow("installed runtime catalog includes capability-tour")
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("installed capability evidence rejects a bundled model-only tour", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "installed-capability-bundle-"))
	const pluginRoot = join(temporaryRoot, "plugin")
	try {
		cpSync(join(root, "plugin"), pluginRoot, { recursive: true })
		const inventoryPath = join(pluginRoot, "runtime", "bundle-inventory.json")
		const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
		inventory.bundles["capability-tour"] = inventory.bundles["hello-world"]
		writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, "\t")}\n`)
		expect(() =>
			proveInstalledCapabilityEvidence(
				pluginRoot,
				"codex",
				"a".repeat(40),
				runtimeClosureEvidence(pluginRoot).payloadHash,
			),
		).toThrow("installed bundle inventory differs")
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("release proof requires both native harness CLIs", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
	expect(packageJson.scripts["prove:harness-install"]).toBe(
		"bun run scripts/prove-harness-install.ts",
	)
	expect(packageJson.scripts["prove:all"]).toContain("prove:harness-install -- --require-native")
	expect(packageJson.scripts["prove:all"]).toContain("--fixture-acknowledged")
})

test("native runtime qualification requires explicit fixture acknowledgement", () => {
	expect(() =>
		proveHarnessInstall(root, {
			qualifyRuntimeJourney: true,
		}),
	).toThrow("requires --fixture-acknowledged")
})

test("native harness commands receive no publication credentials", () => {
	const environment = nativeHarnessEnvironment({
		PATH: "/usr/bin:/bin",
		HOME: "/tmp/home",
		GIT_CONFIG_GLOBAL: "/tmp/credential-lease/gitconfig",
		GIT_CONFIG_NOSYSTEM: "1",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
		GH_TOKEN: "secret",
		GITHUB_TOKEN: "secret",
		CANARY_GH_TOKEN: "secret",
		CANARY_SSH_PRIVATE_KEY: "secret",
		RELEASE_PLEASE_TOKEN: "secret",
	})

	expect(environment).toEqual({
		PATH: "/usr/bin:/bin",
		HOME: "/tmp/home",
		GIT_CONFIG_GLOBAL: "/tmp/credential-lease/gitconfig",
		GIT_CONFIG_NOSYSTEM: "1",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
	})
	expect(JSON.stringify(environment)).not.toContain("secret")
})

test.each([
	"git@github.com:myagentdojo/private-canary.git",
	"https://github.com/myagentdojo/private-canary.git",
] as const)("hosted native installs preserve the proven Git remote %s", (remote) => {
	const ref = `candidate/${"a".repeat(40)}`
	expect(hostedMarketplaceSources(remote, ref)).toEqual({
		claude: `${remote}#${ref}`,
		codex: remote,
		ref,
	})
})

test("strict CLI fails closed instead of reporting fixture-copy qualification", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/prove-harness-install.ts", "--require-native", "--json"],
		cwd: root,
		env: { ...process.env, PATH: "/usr/bin:/bin" },
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("native harness CLIs are required")
})

test("default CLI also fails closed when native CLIs are unavailable", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/prove-harness-install.ts", "--json"],
		cwd: root,
		env: { ...process.env, PATH: "/usr/bin:/bin" },
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("native harness CLIs are required")
})

test("strict CLI checks native CLIs before fixture Git work", () => {
	const executableRoot = mkdtempSync(join(tmpdir(), "harness-native-path-"))
	const gitMarker = join(executableRoot, "git-called")
	const gitExecutable = join(executableRoot, "git")
	writeFileSync(gitExecutable, `#!/bin/sh\n: > ${JSON.stringify(gitMarker)}\nexit 99\n`)
	chmodSync(gitExecutable, 0o755)
	try {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"run",
				"scripts/prove-harness-install.ts",
				"--require-native",
				"--json",
			],
			cwd: root,
			env: { ...process.env, PATH: executableRoot },
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(1)
		expect(result.stderr.toString()).toContain("native harness CLIs are required")
		expect(existsSync(gitMarker)).toBe(false)
	} finally {
		rmSync(executableRoot, { recursive: true, force: true })
	}
})

test("CLI rejects conflicting native proof modes as usage", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"scripts/prove-harness-install.ts",
			"--require-native",
			"--allow-fixture-copy",
			"--json",
		],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(2)
	expect(result.stderr.toString()).toContain(
		"--require-native cannot be combined with --allow-fixture-copy",
	)
})

test("cleaned CLI evidence redacts direct and macOS-aliased temporary paths", () => {
	const temporaryRoot = "/var/folders/example/harness-install-proof-abc"
	expect(redactTemporaryEvidencePath(`${temporaryRoot}/codex/home`, temporaryRoot)).toBe(
		"[cleaned temporary evidence: codex/home]",
	)
	expect(
		redactTemporaryEvidencePath(
			"/private/var/folders/example/harness-install-proof-abc/codex/home",
			temporaryRoot,
		),
	).toBe("[cleaned temporary evidence: codex/home]")
})

test("cleaned CLI proof reports that temporary evidence was removed", () => {
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"scripts/prove-harness-install.ts",
			"--allow-fixture-copy",
			"--json",
		],
		cwd: root,
		env: { ...process.env, PATH: "/usr/bin:/bin" },
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		evidenceRetained: false,
		codex: {
			mode: "fixture-copy",
			installedState: null,
		},
		capabilityEvidence: {
			clients: {
				claude: { nativeActivation: "not-proved" },
				codex: { nativeActivation: "not-proved" },
			},
		},
	})
}, 60_000)

claudeNativeTest("AE6: Claude native scopes preserve state (Claude CLI required; fallback proves bytes)", () => {
	expect(proof.claude.mode).toBe("native-local-marketplace")
	expect(proof.claude.scopes.map((entry: { scope: string }) => entry.scope)).toEqual([
		"user",
		"project",
		"local",
	])
	for (const scope of proof.claude.scopes) {
		expect(scope.initialVersion).toBe(proof.preflight.manifestVersion)
		expect(scope.upgradedVersion).toBe(proof.targetPreflight.manifestVersion)
		expect(scope.rolledBackVersion).toBe(proof.preflight.manifestVersion)
		expect(scope.initialEnabled).toBe(false)
		expect(scope.enabledAfterReview).toBe(true)
		expect(scope.dataMarkerPreserved).toBe(true)
		expect(scope.failureRestored).toBe(true)
	}
})

claudeNativeTest("Claude host selects active cache (Claude CLI required; fallback proves bytes)", () => {
	for (const scope of proof.claude.scopes) {
		expect(scope.orphanedCacheIgnored).toBe(true)
		expect(scope.activeCachePath).not.toContain("0.0.0-orphaned")
	}
	expect(proof.claude.requestedRef).toBe(proof.preflight.requestedRef)
	expect(proof.claude.resolvedSha).toBe(proof.preflight.resolvedSha)
})

test("Claude default-disabled installation names the 2.1.154 compatibility boundary", () => {
	expect(proof.claude.defaultEnabled).toBe(false)
	expect(proof.claude.compatibility).toEqual(CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY)
	expect(proof.claude.compatibility.minimumVersion).toBe("2.1.154")
	expect(proof.claude.compatibility.warning).toContain("Earlier Claude Code clients")
})

test("Git transport admission distinguishes local, SSH, HTTPS, and token-only inputs", () => {
	expect(admitGitTransport({ source: "/tmp/repository", transport: "local" })).toEqual({
		source: "/tmp/repository",
		transport: "local",
	})
	expect(() =>
		admitGitTransport({ source: "git@example.invalid:owner/repo", transport: "ssh" }),
	).toThrow("accepted host keys")
	expect(() =>
		admitGitTransport({
			source: "git@example.invalid:owner/repo",
			transport: "ssh",
			hostKeyAccepted: true,
		}),
	).toThrow("agent-loaded key")
	expect(
		admitGitTransport({
			source: "git@example.invalid:owner/repo",
			transport: "ssh",
			hostKeyAccepted: true,
			agentKeyLoaded: true,
		}),
	).toMatchObject({ transport: "ssh" })
	expect(() =>
		admitGitTransport({ source: "https://example.invalid/owner/repo", transport: "https" }),
	).toThrow("credential helper")
	expect(
		admitGitTransport({
			source: "https://example.invalid/owner/repo",
			transport: "https",
			credentialHelperConfigured: true,
		}),
	).toMatchObject({ transport: "https" })
	expect(() =>
		admitGitTransport({
			source: "https://example.invalid/owner/repo",
			transport: "https",
			tokenEnvironmentOnly: true,
		}),
	).toThrow("token environment variables alone")
})

test("AE9: target and restoration preflight failures leave the active cache untouched", () => {
	const activeRuntime = join(proof.codex.installedPath, "runtime", "hello-world.js")
	const before = readFileSync(activeRuntime)
	expect(() =>
		assertReplacementAdmission({
			target: proof.targetPreflight,
			restoration: proof.preflight,
			allowedRefs: [proof.preflight.requestedRef],
			managed: false,
			removable: true,
		}),
	).toThrow("denied before mutation")
	expect(() =>
		assertReplacementAdmission({
			target: { ...proof.targetPreflight, resolvedSha: "unresolved" },
			restoration: proof.preflight,
			allowedRefs: [proof.preflight.requestedRef, proof.targetPreflight.requestedRef],
			managed: false,
			removable: true,
		}),
	).toThrow("no proven commit")
	expect(() =>
		assertReplacementAdmission({
			target: proof.targetPreflight,
			restoration: { ...proof.preflight, manifestVersion: "9.9.9" },
			allowedRefs: [proof.preflight.requestedRef, proof.targetPreflight.requestedRef],
			managed: false,
			removable: true,
		}),
	).toThrow("does not match inspected manifest")
	expect(readFileSync(activeRuntime)).toEqual(before)
})

test("managed or non-removable Codex state blocks with administrator handoff", () => {
	for (const state of [
		{ managed: true, removable: true },
		{ managed: false, removable: false },
	]) {
		expect(() =>
			assertReplacementAdmission({
				target: proof.targetPreflight,
				restoration: proof.preflight,
				allowedRefs: [proof.preflight.requestedRef, proof.targetPreflight.requestedRef],
				...state,
			}),
		).toThrow("administrator handoff required")
	}
})

codexNativeTest("Codex JSON records native state (Codex CLI required; fallback proves bytes)", () => {
	expect(proof.codex.mode).toBe("native-local-marketplace")
	expect(proof.codex.marketplaceIdentity).toBe("harness-native-plugin-prototype")
	expect(proof.codex.configuredRef).toBe(proof.preflight.requestedRef)
	expect(proof.codex.installedMarketplaceRoot).toBeTruthy()
	expect(proof.codex.installedPath).toBeTruthy()
	expect(proof.codex.version).toBe(proof.preflight.manifestVersion)
	expect(proof.codex.enabled).toBe(true)
	expect(proof.codex.installPolicy).toBe("AVAILABLE")
	expect(proof.codex.authPolicy).toBe("ON_INSTALL")
	const jsonEvidence = proof.codex.jsonEvidence
	expect(jsonEvidence).not.toBeNull()
	if (!jsonEvidence) throw new Error("native Codex proof omitted JSON evidence")
	expect(jsonEvidence.marketplaceList.marketplaces).toHaveLength(1)
	expect(jsonEvidence.pluginList.installed).toHaveLength(1)
})

codexNativeTest("Codex local refresh changes bytes (Codex CLI required; fallback proves bytes)", () => {
	expect(proof.codex.marketplaceCacheVersion).toBe("local")
	expect(proof.codex.localRefresh.bytesChanged).toBe(true)
	expect(proof.codex.localRefresh.rolledBack).toBe(true)
	expect(proof.codex.localRefresh.enabledStateRestored).toBe(true)
	expect(proof.codex.localRefresh.failureRestored).toBe(true)
})

test("Codex installed state never claims native activation", () => {
	if (proof.codex.mode === "fixture-copy") {
		expect(proof.codex.installedState).toBeNull()
		return
	}
	expect(proof.codex.installedState).toMatchObject({
		pluginEnabled: true,
		executionEntry: "explicit skill launcher",
		runtimeRepairOwner: "agent workflow with human approval",
	})
})

test("AE10: a versioned release changes exact payload evidence without changing inventory", () => {
	const before = runtimeClosureEvidence(join(proof.preflight.checkoutRoot, "plugin"))
	const after = runtimeClosureEvidence(join(proof.targetPreflight.checkoutRoot, "plugin"))

	expect(before.version).not.toBe(after.version)
	expect(before.inventoryHash).toBe(after.inventoryHash)
	expect(before.payloadHash).not.toBe(after.payloadHash)
	expect(proof.payloadClosureChanged).toBe(true)
})

test.each([
	"bin/hello-world",
	"bin/skill-a",
	"bin/skill-b",
	"runtime/hello-world.js",
	"runtime/runtime-exec",
	"runtime/runtime-lock.sh",
	"runtime/skill-catalog.sh",
] as const)("AE10: changing only %s under a new version changes payload evidence", (changedPath) => {
	const variantRoot = join(proof.temporaryRoot, "closure-variants", changedPath.replaceAll("/", "-"))
	cpSync(join(proof.preflight.checkoutRoot, "plugin"), join(variantRoot, "plugin"), {
		recursive: true,
	})
	mkdirSync(join(variantRoot, ".claude-plugin"), { recursive: true })
	mkdirSync(join(variantRoot, ".agents", "plugins"), { recursive: true })
	const config = JSON.parse(
		readFileSync(join(root, "plugin.config.json"), "utf8"),
	) as PluginConfig
	config.version = proof.targetPreflight.manifestVersion
	writeGeneratedFiles(variantRoot, config)
	const changedFile = join(variantRoot, "plugin", changedPath)
	writeFileSync(changedFile, Buffer.concat([readFileSync(changedFile), Buffer.from("u6-change")]))

	const before = runtimeClosureEvidence(join(proof.preflight.checkoutRoot, "plugin"))
	const after = runtimeClosureEvidence(join(variantRoot, "plugin"))
	expect(after.inventoryHash).toBe(before.inventoryHash)
	expect(after.payloadHash).not.toBe(before.payloadHash)
})

test("payload inspection failure occurs before an active install can change", () => {
	const fixtureRoot = join(proof.temporaryRoot, "unsafe-payload")
	const pluginRoot = join(fixtureRoot, "plugin")
	mkdirSync(pluginRoot, { recursive: true })
	mkdirSync(join(pluginRoot, "empty"))
	const activeBytes = readFileSync(join(proof.claude.activeCachePath, "runtime", "hello-world.js"))
	expect(() => proveHarnessInstall(fixtureRoot)).toThrow(
		'unsafe plugin payload entry "plugin/empty": empty directory',
	)
	expect(readFileSync(join(proof.claude.activeCachePath, "runtime", "hello-world.js"))).toEqual(
		activeBytes,
	)
})

test.skip(
	"Codex Desktop discovery and approved repair/retry smoke has a named manual receipt",
	() => {},
)

test.skip(
	"private SSH/HTTPS fetch and background refresh use real credentials (hermetic proof never accesses private remotes)",
	() => {},
)

test.skip(
	"hosted Git marketplace fresh task discovers and runs the selected skill (requires live model access)",
	() => {},
)
