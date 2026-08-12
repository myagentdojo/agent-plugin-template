import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, test } from "bun:test"

const root = new URL("..", import.meta.url).pathname
const temporaryRoots: string[] = []
const hermeticBunPath = `${dirname(process.execPath)}:/usr/bin:/bin`

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

function run(arguments_: string[], environment: Record<string, string> = {}): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "update", "--", ...arguments_],
		cwd: root,
		env: { ...process.env, ...environment },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
}

function git(arguments_: string[], cwd: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", ...arguments_],
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) throw new Error(result.stderr.toString())
	return result.stdout.toString().trim()
}

function writeRelease(repositoryRoot: string, version: string, runtimeMarker: string): void {
	cpSync(join(root, "plugin"), join(repositoryRoot, "plugin"), { recursive: true, force: true })
	cpSync(join(root, ".agents"), join(repositoryRoot, ".agents"), { recursive: true, force: true })
	cpSync(join(root, ".claude-plugin"), join(repositoryRoot, ".claude-plugin"), {
		recursive: true,
		force: true,
	})
	cpSync(join(root, "runtime"), join(repositoryRoot, "runtime"), { recursive: true, force: true })
	cpSync(join(root, "plugin.config.json"), join(repositoryRoot, "plugin.config.json"), {
		force: true,
	})
	const pluginConfig = JSON.parse(readFileSync(join(repositoryRoot, "plugin.config.json"), "utf8"))
	pluginConfig.version = version
	writeFileSync(
		join(repositoryRoot, "plugin.config.json"),
		`${JSON.stringify(pluginConfig, null, 2)}\n`,
	)
	const manifest = JSON.parse(
		readFileSync(join(repositoryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	manifest.version = version
	writeFileSync(
		join(repositoryRoot, "plugin", ".codex-plugin", "plugin.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	)
	const claudeManifest = JSON.parse(
		readFileSync(join(repositoryRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	)
	claudeManifest.version = version
	writeFileSync(
		join(repositoryRoot, "plugin", ".claude-plugin", "plugin.json"),
		`${JSON.stringify(claudeManifest, null, 2)}\n`,
	)
	writeFileSync(join(repositoryRoot, "plugin", "runtime", "hello-world.js"), runtimeMarker)
	const claudeMarketplace = JSON.parse(
		readFileSync(join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
	)
	claudeMarketplace.plugins[0].version = version
	writeFileSync(
		join(repositoryRoot, ".claude-plugin", "marketplace.json"),
		`${JSON.stringify(claudeMarketplace, null, 2)}\n`,
	)
	const proofPath = join(repositoryRoot, "runtime", "src", "portable-command.test.ts")
	writeFileSync(
		proofPath,
		`${readFileSync(proofPath, "utf8")}\ntest("functional proof stays bound to Release ${version}", async () => {\n\tconst releaseConfig = await Bun.file(new URL("../../plugin.config.json", import.meta.url)).json()\n\texpect(releaseConfig.version).toBe(${JSON.stringify(version)})\n})\n`,
	)
}

function createReleaseRepository(temporaryRoot: string): {
	priorCommit: string
	repositoryRoot: string
	targetCommit: string
} {
	const repositoryRoot = join(temporaryRoot, "repository")
	mkdirSync(repositoryRoot)
	git(["init", "--quiet"], repositoryRoot)
	git(["config", "user.name", "Update Test"], repositoryRoot)
	git(["config", "user.email", "update-test@example.invalid"], repositoryRoot)
	writeRelease(repositoryRoot, "0.1.0", "old runtime\n")
	git(["add", "."], repositoryRoot)
	git(["commit", "--quiet", "-m", "release 0.1.0"], repositoryRoot)
	git(["tag", "-a", "v0.1.0", "-m", "v0.1.0"], repositoryRoot)
	writeRelease(repositoryRoot, "0.1.1", "new runtime\n")
	git(["add", "."], repositoryRoot)
	git(["commit", "--quiet", "-m", "release 0.1.1"], repositoryRoot)
	git(["tag", "v0.1.1"], repositoryRoot)
	return {
		priorCommit: git(["rev-parse", "refs/tags/v0.1.0^{commit}"], repositoryRoot),
		repositoryRoot,
		targetCommit: git(["rev-parse", "refs/tags/v0.1.1^{commit}"], repositoryRoot),
	}
}

function checkoutRelease(repositoryRoot: string, tag: string, destination: string): void {
	git(["clone", "--quiet", repositoryRoot, destination], join(destination, ".."))
	git(["checkout", "--quiet", "--detach", tag], destination)
}

function releaseProof(checkoutRoot: string): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "test", "runtime/src/portable-command.test.ts"],
		cwd: checkoutRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
}

function updateFixture(): {
	codeHome: string
	installedPath: string
	marketplaceRoot: string
	mutationMarker: string
	path: string
	priorCommit: string
	repositoryRoot: string
	statePath: string
	targetCommit: string
} {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "production-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const { priorCommit, repositoryRoot, targetCommit } = createReleaseRepository(temporaryRoot)

	const codeHome = join(temporaryRoot, "codex")
	const marketplaceRoot = join(codeHome, ".tmp", "marketplaces", "harness-native-plugin-prototype")
	mkdirSync(join(marketplaceRoot, ".."), { recursive: true })
	git(["clone", "--quiet", repositoryRoot, marketplaceRoot], temporaryRoot)
	git(["checkout", "--quiet", "--detach", priorCommit], marketplaceRoot)
	writeFileSync(
		join(marketplaceRoot, ".codex-marketplace-install.json"),
		`${JSON.stringify(
			{
				source_type: "git",
				source: repositoryRoot,
				ref_name: "v0.1.0",
				sparse_paths: [],
				revision: priorCommit,
			},
			null,
			2,
		)}\n`,
	)
	const installedPath = join(
		codeHome,
		"plugins",
		"cache",
		"harness-native-plugin-prototype",
		"harness-native-plugin-prototype",
		"0.1.0",
	)
	cpSync(join(marketplaceRoot, "plugin"), installedPath, { recursive: true })
	writeFileSync(
		join(codeHome, "config.toml"),
		`[marketplaces.harness-native-plugin-prototype]\nlast_revision = "${priorCommit}"\nsource_type = "git"\nsource = ${JSON.stringify(repositoryRoot)}\nref = "v0.1.0"\n\n[plugins."harness-native-plugin-prototype@harness-native-plugin-prototype"]\nenabled = true\n`,
	)

	const statePath = join(temporaryRoot, "codex-state.json")
	writeFileSync(
		statePath,
		JSON.stringify({
			marketplaces: {
				marketplaces: [
					{
						name: "harness-native-plugin-prototype",
						root: marketplaceRoot,
						marketplaceSource: { sourceType: "git", source: repositoryRoot },
					},
				],
			},
			plugins: {
				installed: [
					{
						pluginId: "harness-native-plugin-prototype@harness-native-plugin-prototype",
						name: "harness-native-plugin-prototype",
						marketplaceName: "harness-native-plugin-prototype",
						version: "0.1.0",
						installed: true,
						enabled: true,
						source: { source: "local", path: join(marketplaceRoot, "plugin") },
						marketplaceSource: { sourceType: "git", source: repositoryRoot },
						installPolicy: "AVAILABLE",
						authPolicy: "ON_INSTALL",
					},
				],
				available: [],
			},
		}),
	)
	const binRoot = join(temporaryRoot, "bin")
	mkdirSync(binRoot)
	const codexExecutable = join(binRoot, "codex")
	writeFileSync(
		codexExecutable,
		`#!/usr/bin/env bun\nconst state = await Bun.file(process.env.UPDATE_TEST_STATE).json()\nconst command = process.argv.slice(2).join(" ")\nif (command === "plugin marketplace list --json") console.log(JSON.stringify(state.marketplaces))\nelse if (command === "plugin list --json") console.log(JSON.stringify(state.plugins))\nelse { await Bun.write(process.env.UPDATE_TEST_MUTATION_MARKER, command); console.error("unexpected mutation: " + command); process.exit(99) }\n`,
	)
	chmodSync(codexExecutable, 0o755)
	return {
		codeHome,
		installedPath: realpathSync(installedPath),
		marketplaceRoot,
		mutationMarker: join(temporaryRoot, "mutation-marker"),
		path: `${binRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		priorCommit,
		repositoryRoot,
		statePath,
		targetCommit,
	}
}

function nativeCodexJson<T>(
	arguments_: string[],
	cwd: string,
	environment: Record<string, string>,
): T {
	const codexExecutable = Bun.which("codex")
	if (!codexExecutable) throw new Error("native Codex CLI is required for update tests")
	const result = Bun.spawnSync({
		cmd: [codexExecutable, ...arguments_],
		cwd,
		env: { ...process.env, ...environment },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) throw new Error(result.stderr.toString())
	return JSON.parse(result.stdout.toString()) as T
}

function nativeUpdateFixture(): {
	codeHome: string
	environment: Record<string, string>
	marketplaceRoot: string
	project: string
	repositoryRoot: string
	source: string
	targetCommit: string
} {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "native-production-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const { repositoryRoot, targetCommit } = createReleaseRepository(temporaryRoot)
	const codeHome = join(temporaryRoot, "codex")
	const project = join(temporaryRoot, "project")
	mkdirSync(codeHome)
	mkdirSync(project)
	const source = "https://github.com/update-fixture/agent-plugin-template.git"
	const environment = {
		CODEX_HOME: codeHome,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.file://${repositoryRoot}.insteadOf`,
		GIT_CONFIG_VALUE_0: source,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
	}
	nativeCodexJson(
		["plugin", "marketplace", "add", source, "--ref", "v0.1.0", "--json"],
		project,
		environment,
	)
	nativeCodexJson(
		["plugin", "add", "harness-native-plugin-prototype@harness-native-plugin-prototype", "--json"],
		project,
		environment,
	)
	const marketplaceList = nativeCodexJson<{
		marketplaces: Array<{ root: string }>
	}>(["plugin", "marketplace", "list", "--json"], project, environment)
	const marketplaceRoot = marketplaceList.marketplaces[0]?.root
	if (!marketplaceRoot) throw new Error("native Codex fixture did not report a Marketplace root")
	return { codeHome, environment, marketplaceRoot, project, repositoryRoot, source, targetCommit }
}

function faultingCodexEnvironment(
	environment: Record<string, string>,
	phase:
		| "after_plugin_remove"
		| "after_marketplace_remove"
		| "after_marketplace_add"
		| "after_plugin_add"
		| "stale_marketplace_add",
	failRecovery = false,
): { environment: Record<string, string>; logPath: string } {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "faulting-codex-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const realCodex = Bun.which("codex")
	if (!realCodex) throw new Error("native Codex CLI is required for update tests")
	const markerPath = join(temporaryRoot, "injected")
	const logPath = join(temporaryRoot, "commands.log")
	const wrapperPath = join(temporaryRoot, "codex")
	writeFileSync(
		wrapperPath,
		`#!/usr/bin/env bun\nimport { appendFileSync, existsSync } from "node:fs"\nconst args = process.argv.slice(2)\nconst command = args.join(" ")\nappendFileSync(process.env.UPDATE_TEST_COMMAND_LOG, command + "\\n")\nconst phase = process.env.UPDATE_TEST_FAIL_PHASE\nconst injected = existsSync(process.env.UPDATE_TEST_FAIL_MARKER)\nconst matches = (phase === "after_plugin_remove" && command.startsWith("plugin remove ")) || (phase === "after_marketplace_remove" && command.startsWith("plugin marketplace remove ")) || (phase === "after_marketplace_add" && command.startsWith("plugin marketplace add ") && args.includes("v0.1.1")) || (phase === "after_plugin_add" && command.startsWith("plugin add "))\nif (injected && process.env.UPDATE_TEST_FAIL_RECOVERY === "1" && command.startsWith("plugin marketplace add ") && args.includes("v0.1.0")) { console.error("injected recovery failure"); process.exit(75) }\nlet delegatedArgs = args\nif (!injected && phase === "stale_marketplace_add" && command.startsWith("plugin marketplace add ") && args.includes("v0.1.1")) { delegatedArgs = args.map((value) => value === "v0.1.1" ? "v0.1.0" : value); await Bun.write(process.env.UPDATE_TEST_FAIL_MARKER, phase) }\nconst result = Bun.spawnSync({ cmd: [process.env.UPDATE_TEST_REAL_CODEX, ...delegatedArgs], env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })\nif (!injected && matches && result.exitCode === 0) { await Bun.write(process.env.UPDATE_TEST_FAIL_MARKER, phase); console.error("injected failure " + phase); process.exit(74) }\nprocess.stdout.write(result.stdout)\nprocess.stderr.write(result.stderr)\nprocess.exit(result.exitCode)\n`,
	)
	chmodSync(wrapperPath, 0o755)
	return {
		environment: {
			...environment,
			PATH: `${temporaryRoot}:${environment.PATH}`,
			UPDATE_TEST_COMMAND_LOG: logPath,
			UPDATE_TEST_FAIL_MARKER: markerPath,
			UPDATE_TEST_FAIL_PHASE: phase,
			UPDATE_TEST_FAIL_RECOVERY: failRecovery ? "1" : "0",
			UPDATE_TEST_REAL_CODEX: realCodex,
		},
		logPath,
	}
}

function releaseApiEnvironment(
	environment: Record<string, string>,
	releases: Array<{ tag_name: string; draft: boolean; prerelease: boolean }>,
): Record<string, string> {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "release-api-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const ghExecutable = join(temporaryRoot, "gh")
	writeFileSync(
		ghExecutable,
		`#!/usr/bin/env bun\nconst releases = JSON.parse(process.env.UPDATE_TEST_RELEASES)\nconsole.log(JSON.stringify([releases]))\n`,
	)
	chmodSync(ghExecutable, 0o755)
	return {
		...environment,
		PATH: `${temporaryRoot}:${environment.PATH}`,
		UPDATE_TEST_RELEASES: JSON.stringify(releases),
	}
}

function movingTagEnvironment(
	environment: Record<string, string>,
	repositoryRoot: string,
): Record<string, string> {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "moving-tag-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const realGit = Bun.which("git")
	if (!realGit) throw new Error("Git is required for moving-tag update tests")
	const wrapperPath = join(temporaryRoot, "git")
	writeFileSync(
		wrapperPath,
		`#!/usr/bin/env bun\nimport { existsSync, readFileSync, writeFileSync } from "node:fs"\nconst args = process.argv.slice(2)\nlet fetchCount = existsSync(process.env.UPDATE_TEST_GIT_COUNT) ? Number(readFileSync(process.env.UPDATE_TEST_GIT_COUNT, "utf8")) : 0\nif (args[0] === "fetch") { fetchCount += 1; writeFileSync(process.env.UPDATE_TEST_GIT_COUNT, String(fetchCount)); if (fetchCount === 3) { const moved = Bun.spawnSync({ cmd: [process.env.UPDATE_TEST_REAL_GIT, "-C", process.env.UPDATE_TEST_MOVING_REPO, "tag", "--force", "v0.1.1", "v0.1.0^{commit}"], stdin: "ignore", stdout: "pipe", stderr: "pipe" }); if (moved.exitCode !== 0) process.exit(moved.exitCode) } }\nconst result = Bun.spawnSync({ cmd: [process.env.UPDATE_TEST_REAL_GIT, ...args], env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })\nprocess.stdout.write(result.stdout)\nprocess.stderr.write(result.stderr)\nprocess.exit(result.exitCode)\n`,
	)
	chmodSync(wrapperPath, 0o755)
	return {
		...environment,
		PATH: `${temporaryRoot}:${environment.PATH}`,
		UPDATE_TEST_GIT_COUNT: join(temporaryRoot, "fetch-count"),
		UPDATE_TEST_MOVING_REPO: repositoryRoot,
		UPDATE_TEST_REAL_GIT: realGit,
	}
}

test("public update command shows concise preview-first help with no arguments", () => {
	const result = run([], { PATH: hermeticBunPath })

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toContain("bun run update -- --harness codex")
	expect(result.stdout.toString()).toContain("Preview by default")
	expect(result.stdout.toString()).toContain("--apply")
	expect(result.stdout.toString()).toContain("refreshes the configured ref")
	expect(result.stdout.toString()).toContain("selects a newer immutable Release")
})

test("JSON usage failures stay machine-readable and make retry safety explicit", () => {
	const result = run(["--unknown", "--json"], { PATH: hermeticBunPath })

	expect(result.exitCode).toBe(2)
	const failure = JSON.parse(result.stdout.toString())
	expect(failure).toMatchObject({
		schemaVersion: 1,
		contractId: "plugin.production-update",
		ok: false,
		category: "usage",
		changed: false,
		transactionState: "blocked",
		retrySafety: "safe",
		sideEffects: [],
		nextAction: "bun run update -- --help",
	})
	expect(failure.runId).toBeString()
	expect(result.stderr.toString()).toContain("unknown option")
})

test("conflicting target selectors fail before state discovery", () => {
	const result = run(
		["--harness", "codex", "--target", "v0.1.0", "--target", "v0.1.1", "--json"],
		{ PATH: hermeticBunPath },
	)

	expect(result.exitCode).toBe(2)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "usage",
		changed: false,
		transactionState: "blocked",
	})
	expect(result.stderr.toString()).toContain("--target may be provided once")
})

test("matched Release proofs pass while old tests reject the new Release checkout", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "release-lineage-update-test-"))
	temporaryRoots.push(temporaryRoot)
	const { repositoryRoot } = createReleaseRepository(temporaryRoot)
	const baseCheckout = join(temporaryRoot, "base-checkout")
	const targetCheckout = join(temporaryRoot, "target-checkout")
	checkoutRelease(repositoryRoot, "v0.1.0", baseCheckout)
	checkoutRelease(repositoryRoot, "v0.1.1", targetCheckout)

	expect(releaseProof(baseCheckout).exitCode).toBe(0)
	expect(releaseProof(targetCheckout).exitCode).toBe(0)
	writeFileSync(
		join(targetCheckout, "runtime", "src", "portable-command.test.ts"),
		readFileSync(join(baseCheckout, "runtime", "src", "portable-command.test.ts")),
	)
	expect(releaseProof(targetCheckout).exitCode).toBe(1)
})

test("explicit-target preview binds target and restoration releases without mutation", () => {
	const fixture = updateFixture()
	const result = run(["--harness", "codex", "--target", "v0.1.1", "--json", "--no-input"], {
		CODEX_HOME: fixture.codeHome,
		PATH: fixture.path,
		UPDATE_TEST_MUTATION_MARKER: fixture.mutationMarker,
		UPDATE_TEST_STATE: fixture.statePath,
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const preview = JSON.parse(result.stdout.toString())
	expect(preview).toMatchObject({
		schemaVersion: 1,
		contractId: "plugin.production-update",
		ok: true,
		mode: "preview",
		harness: "codex",
		changed: false,
		wouldChange: true,
		transactionState: "previewed",
		retrySafety: "safe",
		selectedRelease: {
			requested: "v0.1.1",
			tag: "v0.1.1",
			commit: fixture.targetCommit,
			manifestVersion: "0.1.1",
		},
		prior: {
			ref: "v0.1.0",
			version: "0.1.0",
			installedPath: fixture.installedPath,
			enabled: true,
		},
		proof: {
			kind: "in_place_update",
			status: "target_preflight",
			selectedRelease: "v0.1.1",
			marketplaceRelease: "v0.1.0",
			installationRelease: "v0.1.0",
			functionalProofRelease: "v0.1.1",
			lineageMatched: false,
			freshInstall: "not_run",
		},
	})
	expect(preview.sideEffects).toEqual([
		"read Codex Marketplace and Plugin Installation state",
		"fetch and admit the target Release in a temporary detached checkout",
		"fetch and admit the restoration Release in a temporary detached checkout",
		"run functional proof from the selected Release checkout",
	])
	expect(existsSync(fixture.mutationMarker)).toBe(false)
})

test("apply is a successful no-op when the selected immutable Release is current", () => {
	const fixture = updateFixture()
	const result = run(
		["--harness", "codex", "--target", "v0.1.0", "--apply", "--json", "--no-input"],
		{
			CODEX_HOME: fixture.codeHome,
			PATH: fixture.path,
			UPDATE_TEST_MUTATION_MARKER: fixture.mutationMarker,
			UPDATE_TEST_STATE: fixture.statePath,
		},
	)

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const noOp = JSON.parse(result.stdout.toString())
	expect(noOp).toMatchObject({
		ok: true,
		mode: "apply",
		changed: false,
		wouldChange: false,
		transactionState: "no_op",
		retrySafety: "safe",
		selectedRelease: {
			tag: "v0.1.0",
			commit: fixture.priorCommit,
			manifestVersion: "0.1.0",
		},
		prior: { ref: "v0.1.0", commit: fixture.priorCommit, version: "0.1.0" },
	})
	expect(noOp.nextAction).toContain("No update is required")
	expect(existsSync(fixture.mutationMarker)).toBe(false)
})

test("apply replaces the old immutable Release through the real native Codex CLI", () => {
	const fixture = nativeUpdateFixture()
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--apply", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const applied = JSON.parse(result.stdout.toString())
	expect(applied).toMatchObject({
		ok: true,
		mode: "apply",
		changed: true,
		wouldChange: true,
		transactionState: "updated",
		retrySafety: "safe",
		selectedRelease: {
			tag: "v0.1.1",
			commit: fixture.targetCommit,
			manifestVersion: "0.1.1",
		},
		prior: { ref: "v0.1.0", version: "0.1.0" },
		resulting: {
			source: fixture.source,
			ref: "v0.1.1",
			commit: fixture.targetCommit,
			version: "0.1.1",
			enabled: true,
		},
		proof: {
			status: "installed_match",
			selectedRelease: "v0.1.1",
			marketplaceRelease: "v0.1.1",
			installationRelease: "v0.1.1",
			functionalProofRelease: "v0.1.1",
			lineageMatched: true,
			freshInstall: "not_run",
		},
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.1")
	expect(readFileSync(join(applied.resulting.installedPath, "runtime", "hello-world.js"), "utf8")).toBe(
		"new runtime\n",
	)
})

test("latest selects the highest stable GitHub Release and excludes drafts and prereleases", () => {
	const fixture = nativeUpdateFixture()
	const environment = releaseApiEnvironment(fixture.environment, [
		{ tag_name: "v9.0.0", draft: true, prerelease: false },
		{ tag_name: "v1.0.0-rc.1", draft: false, prerelease: true },
		{ tag_name: "v0.1.0", draft: false, prerelease: false },
		{ tag_name: "v0.1.1", draft: false, prerelease: false },
	])
	const result = run(
		["--harness", "codex", "--target", "latest", "--json", "--no-input"],
		environment,
	)

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const preview = JSON.parse(result.stdout.toString())
	expect(preview.selectedRelease).toMatchObject({
		requested: "latest",
		tag: "v0.1.1",
		commit: fixture.targetCommit,
		manifestVersion: "0.1.1",
	})
	expect(preview.transactionState).toBe("previewed")
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("latest fails closed when GitHub reports no stable Release", () => {
	const fixture = nativeUpdateFixture()
	const environment = releaseApiEnvironment(fixture.environment, [
		{ tag_name: "v9.0.0", draft: true, prerelease: false },
		{ tag_name: "v1.0.0-rc.1", draft: false, prerelease: true },
	])
	const result = run(
		["--harness", "codex", "--target", "latest", "--json", "--no-input"],
		environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "release_selection",
		changed: false,
		transactionState: "blocked",
		retrySafety: "safe",
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("disabled Plugin Installation blocks before mutation because Codex cannot restore it", () => {
	const fixture = nativeUpdateFixture()
	const configPath = join(fixture.codeHome, "config.toml")
	writeFileSync(
		configPath,
		readFileSync(configPath, "utf8").replace("enabled = true", "enabled = false"),
	)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--apply", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "mutation_blocked",
		changed: false,
		transactionState: "blocked",
		retrySafety: "safe",
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string; enabled: boolean }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]).toMatchObject({ version: "0.1.0", enabled: false })
})

test("workspace or managed Marketplace state outside CODEX_HOME requires administrator handoff", () => {
	const fixture = updateFixture()
	const externalMarketplace = join(fixture.codeHome, "..", "managed-marketplace")
	cpSync(fixture.marketplaceRoot, externalMarketplace, { recursive: true })
	const state = JSON.parse(readFileSync(fixture.statePath, "utf8"))
	state.marketplaces.marketplaces[0].root = externalMarketplace
	state.plugins.installed[0].source.path = join(externalMarketplace, "plugin")
	writeFileSync(fixture.statePath, JSON.stringify(state))

	const result = run(["--harness", "codex", "--target", "v0.1.1", "--json", "--no-input"], {
		CODEX_HOME: fixture.codeHome,
		PATH: fixture.path,
		UPDATE_TEST_MUTATION_MARKER: fixture.mutationMarker,
		UPDATE_TEST_STATE: fixture.statePath,
	})

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "mutation_blocked",
		changed: false,
		transactionState: "blocked",
	})
	expect(result.stderr.toString()).toContain("outside the user-owned Codex home")
	expect(existsSync(fixture.mutationMarker)).toBe(false)
})

test("missing explicit Release tag fails before changing the active installation", () => {
	const fixture = nativeUpdateFixture()
	const result = run(
		["--harness", "codex", "--target", "v9.9.9", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "release_preflight",
		changed: false,
		transactionState: "blocked",
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("explicit tag whose manifest version differs fails before mutation", () => {
	const fixture = nativeUpdateFixture()
	git(["tag", "v0.1.2", fixture.targetCommit], fixture.repositoryRoot)
	const result = run(
		["--harness", "codex", "--target", "v0.1.2", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "release_preflight",
		changed: false,
		transactionState: "blocked",
	})
})

test("selected tag movement between preflight and mutation binding fails closed", () => {
	const fixture = nativeUpdateFixture()
	const environment = movingTagEnvironment(fixture.environment, fixture.repositoryRoot)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--json", "--no-input"],
		environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "release_preflight",
		changed: false,
		transactionState: "blocked",
	})
	expect(result.stderr.toString()).toContain("tag moved")
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("unsafe target Plugin Payload fails admission before mutation", () => {
	const fixture = nativeUpdateFixture()
	writeRelease(fixture.repositoryRoot, "0.1.2", "unsafe runtime\n")
	symlinkSync(
		"runtime/hello-world.js",
		join(fixture.repositoryRoot, "plugin", "unsafe-runtime-link"),
	)
	git(["add", "."], fixture.repositoryRoot)
	git(["commit", "--quiet", "-m", "release 0.1.2 with unsafe payload"], fixture.repositoryRoot)
	git(["tag", "v0.1.2"], fixture.repositoryRoot)
	const result = run(
		["--harness", "codex", "--target", "v0.1.2", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "release_preflight",
		changed: false,
		transactionState: "blocked",
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("missing current Marketplace ref blocks before target preflight", () => {
	const fixture = nativeUpdateFixture()
	const configPath = join(fixture.codeHome, "config.toml")
	writeFileSync(
		configPath,
		readFileSync(configPath, "utf8").replace(/^ref = .*\n/m, ""),
	)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "current_state",
		changed: false,
		transactionState: "blocked",
	})
})

test("unproved restoration Release blocks before removing the active installation", () => {
	const fixture = nativeUpdateFixture()
	git(["tag", "--delete", "v0.1.0"], fixture.repositoryRoot)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--json", "--no-input"],
		fixture.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "restoration_preflight",
		changed: false,
		transactionState: "blocked",
		sideEffects: [
			"read Codex Marketplace and Plugin Installation state",
			"fetch and admit the target Release in a temporary detached checkout",
		],
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
})

test("zero-error native add that leaves the old ref is rejected and restored", () => {
	const fixture = nativeUpdateFixture()
	const fault = faultingCodexEnvironment(fixture.environment, "stale_marketplace_add")
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--apply", "--json", "--no-input"],
		fault.environment,
	)

	expect(result.exitCode).toBe(1)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: false,
		category: "mutation_failed_restored",
		changed: true,
		transactionState: "restored",
	})
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]?.version).toBe("0.1.0")
	expect(readFileSync(fault.logPath, "utf8").match(/plugin marketplace add .*v0\.1\.1/g)).toHaveLength(
		1,
	)
})

test.each([
	"after_plugin_remove",
	"after_marketplace_remove",
	"after_marketplace_add",
	"after_plugin_add",
] as const)("a failure %s restores and verifies the exact prior Release once", (phase) => {
	const fixture = nativeUpdateFixture()
	const fault = faultingCodexEnvironment(fixture.environment, phase)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--apply", "--json", "--no-input"],
		fault.environment,
	)

	expect(result.exitCode).toBe(1)
	const failure = JSON.parse(result.stdout.toString())
	expect(failure).toMatchObject({
		ok: false,
		category: "mutation_failed_restored",
		changed: true,
		transactionState: "restored",
		retrySafety: "safe",
	})
	expect(failure.sideEffects).toContain("restored and verified the exact prior Release")
	const pluginList = nativeCodexJson<{ installed: Array<{ version: string; enabled: boolean }> }>(
		["plugin", "list", "--json"],
		fixture.project,
		fixture.environment,
	)
	expect(pluginList.installed[0]).toMatchObject({ version: "0.1.0", enabled: true })
	const targetAdds = readFileSync(fault.logPath, "utf8").match(
		/plugin marketplace add .*v0\.1\.1/g,
	) ?? []
	expect(targetAdds).toHaveLength(
		phase === "after_marketplace_add" || phase === "after_plugin_add" ? 1 : 0,
	)
})

test("unverified restoration returns unknown state and never retries the target mutation", () => {
	const fixture = nativeUpdateFixture()
	const fault = faultingCodexEnvironment(fixture.environment, "after_marketplace_add", true)
	const result = run(
		["--harness", "codex", "--target", "v0.1.1", "--apply", "--json", "--no-input"],
		fault.environment,
	)

	expect(result.exitCode).toBe(1)
	const failure = JSON.parse(result.stdout.toString())
	expect(failure).toMatchObject({
		ok: false,
		category: "mutation_state_unknown",
		changed: true,
		transactionState: "unknown",
		retrySafety: "inspect_required",
	})
	const commandLog = readFileSync(fault.logPath, "utf8")
	expect(commandLog.match(/plugin marketplace add .*v0\.1\.1/g)).toHaveLength(1)
	expect(commandLog.match(/plugin marketplace add .*v0\.1\.0/g)).toHaveLength(1)
})
