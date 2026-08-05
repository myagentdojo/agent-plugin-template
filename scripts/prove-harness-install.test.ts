import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, expect, test } from "bun:test"

import {
	admitGitTransport,
	assertReplacementAdmission,
	codexHookTrustEvidence,
	proveHarnessInstall,
	redactTemporaryEvidencePath,
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

beforeAll(() => {
	proof = proveHarnessInstall(root)
}, 60_000)

afterAll(() => {
	if (proof?.temporaryRoot) rmSync(proof.temporaryRoot, { recursive: true, force: true })
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

test("release proof requires both native harness CLIs", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
	expect(packageJson.scripts["prove:harness-install"]).toBe(
		"bun run scripts/prove-harness-install.ts",
	)
	expect(packageJson.scripts["prove:all"]).toContain("prove:harness-install -- --require-native")
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
	expect(proof.codex.jsonEvidence.marketplaceList.marketplaces).toHaveLength(1)
	expect(proof.codex.jsonEvidence.pluginList.installed).toHaveLength(1)
})

codexNativeTest("Codex local refresh changes bytes (Codex CLI required; fallback proves bytes)", () => {
	expect(proof.codex.marketplaceCacheVersion).toBe("local")
	expect(proof.codex.localRefresh.bytesChanged).toBe(true)
	expect(proof.codex.localRefresh.rolledBack).toBe(true)
	expect(proof.codex.localRefresh.enabledStateRestored).toBe(true)
	expect(proof.codex.localRefresh.failureRestored).toBe(true)
})

test("AE8: Codex plugin enablement and hook trust remain separate before interactive acceptance", () => {
	expect(proof.codex.trust).toMatchObject({
		pluginEnabled: true,
		hookDefinitionPresent: true,
		hookTrusted: false,
		preTrustExecution: "skipped",
		separateFromEnablement: true,
	})
})

test("AE10: version and executable changes invalidate the prior exact hook definition", () => {
	const before = codexHookTrustEvidence(join(proof.preflight.checkoutRoot, "plugin"))
	const after = codexHookTrustEvidence(join(proof.targetPreflight.checkoutRoot, "plugin"))

	expect(before.version).not.toBe(after.version)
	expect(before.command).toContain(`--plugin-version ${before.version}`)
	expect(after.command).toContain(`--plugin-version ${after.version}`)
	expect(before.definitionHash).not.toBe(after.definitionHash)
	expect(before.executableClosureHash).not.toBe(after.executableClosureHash)
	expect(proof.trustDefinitionChanged).toBe(true)
})

test.each([
	"bin/hello-world",
	"runtime/hello-world.js",
	"runtime/qjs-darwin-arm64",
	"runtime/qjs-darwin-x86_64",
	"runtime/qjs-linux-aarch64",
	"runtime/qjs-linux-x86_64",
] as const)("AE10: changing only %s under a new version changes trust evidence", (changedPath) => {
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

	const before = codexHookTrustEvidence(join(proof.preflight.checkoutRoot, "plugin"))
	const after = codexHookTrustEvidence(join(variantRoot, "plugin"))
	expect(after.command).toContain(`--plugin-version ${config.version}`)
	expect(after.definitionHash).not.toBe(before.definitionHash)
	expect(after.executableClosureHash).not.toBe(before.executableClosureHash)
})

test("payload inspection failure occurs before an active install can change", () => {
	const fixtureRoot = join(proof.temporaryRoot, "unsafe-payload")
	const pluginRoot = join(fixtureRoot, "plugin")
	mkdirSync(pluginRoot, { recursive: true })
	writeFileSync(join(pluginRoot, "safe.txt"), "safe\n")
	const activeBytes = readFileSync(join(proof.claude.activeCachePath, "runtime", "hello-world.js"))
	writeFileSync(join(pluginRoot, "not-a-manifest.json"), "{}\n")
	expect(() => proveHarnessInstall(fixtureRoot)).toThrow()
	expect(readFileSync(join(proof.claude.activeCachePath, "runtime", "hello-world.js"))).toEqual(
		activeBytes,
	)
})

test.skip(
	"interactive Codex /hooks acceptance proves exact-definition trust (requires a human interactive task)",
	() => {},
)

test.skip(
	"private SSH/HTTPS fetch and background refresh use real credentials (hermetic proof never accesses private remotes)",
	() => {},
)

test.skip(
	"hosted Git marketplace fresh task runs the selected hook (requires live model access)",
	() => {},
)
