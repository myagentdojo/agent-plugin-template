import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { HARNESS_IDENTITIES } from "./harness-identity"
import { pluginPayloadInventory } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
pluginPayloadInventory(root)
const pluginConfig = loadPluginConfig(root)
const claudeManifest = JSON.parse(
	readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
)
const codexManifest = JSON.parse(
	readFileSync(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
)

function codexDryRun(): Record<string, string> {
	const result = Bun.spawnSync({
		cmd: ["bun", "run", "scripts/dev.ts", "codex", "--dry-run", "--json"],
		cwd: root,
		stdout: "pipe",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
	return JSON.parse(result.stdout.toString())
}

function run(
	command: string[],
	options: { cwd: string; environment: Record<string, string | undefined> },
): string {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: options.cwd,
		env: options.environment,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	})
	if (result.exitCode !== 0) {
		process.stderr.write(result.stderr)
		throw new Error(`${command.join(" ")} failed during isolated Development Installation proof`)
	}
	return result.stdout.toString()
}

function runClaudeLifecycle(
	action: "check" | "install" | "restore",
	environment: Record<string, string | undefined>,
	apply = false,
): Record<string, any> {
	return JSON.parse(
		run(
			[
				"bun",
				"run",
				"scripts/dev.ts",
				"claude",
				action,
				...(apply ? ["--apply"] : []),
				"--json",
				"--no-input",
			],
			{ cwd: root, environment },
		),
	)
}

function proveClaudeDevelopmentInstallation(): void {
	if (!Bun.which("claude")) throw new Error("Claude Code is required for the native DX proof")
	const temporaryRoot = mkdtempSync(join(tmpdir(), "claude-development-proof-"))
	const unrelatedDirectory = join(temporaryRoot, "unrelated-directory")
	const profileRoot = join(temporaryRoot, "claude-profile")
	const profileKey = createHash("sha256").update(resolve(profileRoot)).digest("hex").slice(0, 16)
	const snapshot = join(root, ".dev", "claude", "restore-state", `${profileKey}.json`)
	mkdirSync(unrelatedDirectory, { recursive: true })
	const environment = {
		...process.env,
		HOME: join(temporaryRoot, "home"),
		CLAUDE_CONFIG_DIR: profileRoot,
	}
	const productionId = `${pluginConfig.name}@${pluginConfig.name}`
	const developmentId = `${pluginConfig.name}@${pluginConfig.name}-dev`
	const sentinel = join(profileRoot, "plugins", "data", productionId, "restoration-sentinel.txt")
	let installationApplied = false
	let restorationProved = false
	try {
		run(["claude", "plugin", "marketplace", "add", root, "--scope", "user"], {
			cwd: unrelatedDirectory,
			environment,
		})
		run(["claude", "plugin", "install", productionId, "--scope", "user", "--yes"], {
			cwd: unrelatedDirectory,
			environment,
		})
		run(["claude", "plugin", "enable", productionId, "--scope", "user"], {
			cwd: unrelatedDirectory,
			environment,
		})
		mkdirSync(join(sentinel, ".."), { recursive: true })
		writeFileSync(sentinel, "preserve me\n")

		const initial = runClaudeLifecycle("check", environment)
		if (
			initial.current.production !== "installed" ||
			initial.current.development !== "absent" ||
			!initial.current.singleSource
		) {
			throw new Error(
				"isolated Claude profile did not start from one enabled production installation",
			)
		}

		const installed = runClaudeLifecycle("install", environment, true)
		installationApplied = true
		if (
			installed.transactionState !== "installed" ||
			installed.current.development !== "installed" ||
			!installed.current.linkedToCanonicalPayload ||
			!installed.current.singleSource
		) {
			throw new Error("isolated Claude Development Installation was not proved live-linked")
		}

		const plugins = JSON.parse(
			run(["claude", "plugin", "list", "--json"], {
				cwd: unrelatedDirectory,
				environment,
			}),
		) as Array<{ id?: string; scope?: string; enabled?: boolean }>
		const development = plugins.filter((entry) => entry.id === developmentId)
		if (development.length !== 1 || development[0].scope !== "user" || !development[0].enabled) {
			throw new Error("ordinary-directory Claude inspection did not find one enabled user link")
		}
		const details = run(["claude", "plugin", "details", developmentId], {
			cwd: unrelatedDirectory,
			environment,
		})
		if (!details.includes("Skills") || !details.includes("Hooks")) {
			throw new Error("ordinary-directory Claude details omitted Plugin Payload components")
		}

		const restored = runClaudeLifecycle("restore", environment, true)
		restorationProved = true
		if (
			restored.transactionState !== "restored" ||
			restored.current.production !== "installed" ||
			restored.current.development !== "absent" ||
			!restored.current.singleSource
		) {
			throw new Error("isolated Claude profile did not return to its exact production state")
		}
		const productionPlugins = JSON.parse(
			run(["claude", "plugin", "list", "--json"], {
				cwd: unrelatedDirectory,
				environment,
			}),
		) as Array<{ id?: string; version?: string; scope?: string; enabled?: boolean }>
		const production = productionPlugins.filter((entry) => entry.id === productionId)
		if (
			production.length !== 1 ||
			production[0].version !== claudeManifest.version ||
			production[0].scope !== "user" ||
			!production[0].enabled ||
			readFileSync(sentinel, "utf8") !== "preserve me\n"
		) {
			throw new Error("exact production version, enabled state, or retained data was not restored")
		}
	} finally {
		if (installationApplied && !restorationProved) {
			const recovery = Bun.spawnSync({
				cmd: [
					"bun",
					"run",
					"scripts/dev.ts",
					"claude",
					"restore",
					"--apply",
					"--json",
					"--no-input",
				],
				cwd: root,
				env: environment,
				stdout: "ignore",
				stderr: "inherit",
			})
			if (recovery.exitCode !== 0) {
				process.stderr.write("isolated Claude cleanup could not prove restoration\n")
			}
		}
		rmSync(snapshot, { force: true })
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
}

proveClaudeDevelopmentInstallation()
const codex = codexDryRun()

if (!codex.install.includes("plugin add") || !codex.reload.includes("fresh Codex task")) {
	throw new Error("Codex plan does not use the native cached-install and fresh-task boundary")
}

if (claudeManifest.version !== codexManifest.version) {
	throw new Error("native manifest versions do not match")
}
if (
	claudeManifest.hooks !== HARNESS_IDENTITIES.claude.hooksDeclarationPath ||
	codexManifest.hooks !== HARNESS_IDENTITIES.codex.hooksDeclarationPath
) {
	throw new Error("native manifests do not reference the exact client hook declarations")
}
for (const path of [
	"plugin/hooks/claude/hooks.json",
	"plugin/hooks/codex/hooks.json",
	"plugin/hooks/native-capability-hook",
	"plugin/hooks/fixture/lifecycle-mechanics-proof.source.json",
	"plugin/hooks/fixture/lifecycle-mechanics-proof.generated.json",
]) {
	if (!existsSync(join(root, path))) throw new Error(`plugin payload is missing ${path}`)
}
const catalog = JSON.parse(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8"))
const bundles = JSON.parse(
	readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
)
if (
	Object.hasOwn(catalog.skills, "capability-tour") ||
	Object.hasOwn(bundles.bundles, "capability-tour") ||
	existsSync(join(root, "plugin", "bin", "capability-tour"))
) {
	throw new Error("model-only capability-tour entered the executable runtime closure")
}

for (const marketplacePath of [
	join(root, ".agents", "plugins", "marketplace.json"),
	join(root, ".claude-plugin", "marketplace.json"),
]) {
	const marketplace = readFileSync(marketplacePath, "utf8")
	if (!marketplace.includes("./plugin")) {
		throw new Error(`${marketplacePath} does not point at the canonical plugin subtree`)
	}
}

const mainWorkflow = readFileSync(join(root, ".github", "workflows", "plugin-ci.yml"), "utf8")
for (const required of [
	"push:",
	"main",
	"bun run prove:distribution",
	"git diff --exit-code -- plugin/",
]) {
	if (!mainWorkflow.includes(required)) throw new Error(`main workflow is missing ${required}`)
}

console.log(
	JSON.stringify({
		ok: true,
		development: {
			claude:
				"isolated production replacement + persistent user link + ordinary-directory discovery + exact restore",
			codex: "full staged copy + cachebuster + reinstall + fresh task",
		},
		production: "release PR + proof + tag + GitHub Release + harness update",
		boundaries: [
			"one canonical installable plugin/ subtree",
			"no symlinks in the distributed payload",
			"no npm publication",
			"Claude live reload is explicit",
			"Codex reload means a fresh task",
			"direct handler checks do not prove native activation",
		],
		automatedClaimBoundary: {
			nativeDiscovery: "isolated-profile-cli-proved",
			nativeActivation: "not-proved",
			nativeDelegation: "not-proved",
			authenticatedOrdinarySession: "not-proved",
			reloadPlugins: "not-proved",
			qualificationReceiptsIngested: false,
		},
	}),
)
