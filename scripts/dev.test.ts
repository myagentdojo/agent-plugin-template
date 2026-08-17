import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { claudeWatchSources } from "./dev"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const pluginName = pluginConfig.name
const pluginVersion = pluginConfig.version
const productionId = `${pluginName}@${pluginName}`
const developmentMarketplaceName = `${pluginName}-dev`
const developmentId = `${pluginName}@${developmentMarketplaceName}`

interface FakePlugin {
	id: string
	version: string
	scope: string
	enabled: boolean
	installPath: string
}

interface FakeMarketplace {
	name: string
	source: "directory"
	path: string
	installLocation: string
}

interface FakeState {
	plugins: FakePlugin[]
	marketplaces: FakeMarketplace[]
	commands: string[][]
	failCommands?: string[]
	failAfterCommands?: string[]
}

function run(arguments_: string[], environment = process.env) {
	return Bun.spawnSync({
		cmd: [process.execPath, "scripts/dev.ts", ...arguments_],
		cwd: root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
}

function writeExecutable(path: string, contents: string): void {
	writeFileSync(path, contents)
	chmodSync(path, 0o755)
}

function fakeProfile(
	options: {
		production?: boolean
		productionMarketplaceOnly?: boolean
		productionEnabled?: boolean
		plugins?: FakePlugin[]
		marketplaces?: FakeMarketplace[]
		failCommands?: string[]
		failAfterCommands?: string[]
	} = {},
) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "claude-development-test-"))
	const profileRoot = join(temporaryRoot, "claude")
	const binaryRoot = join(temporaryRoot, "bin")
	const statePath = join(temporaryRoot, "state.json")
	const productionMarketplaceRoot = join(temporaryRoot, "production-marketplace")
	mkdirSync(join(productionMarketplaceRoot, ".claude-plugin"), {
		recursive: true,
	})
	writeFileSync(
		join(productionMarketplaceRoot, ".claude-plugin", "marketplace.json"),
		`${JSON.stringify({
			name: pluginName,
			plugins: [
				{
					name: pluginName,
					source: join(root, "plugin"),
				},
			],
		})}\n`,
	)
	mkdirSync(binaryRoot, { recursive: true })
	writeExecutable(
		join(binaryRoot, "claude"),
		`#!/bin/sh\nexec '${process.execPath}' '${join(root, "scripts", "fixtures", "fake-claude.ts")}' "$@"\n`,
	)
	writeExecutable(
		join(binaryRoot, "bun"),
		`#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`,
	)
	const production = options.production ?? false
	const productionMarketplace = production || (options.productionMarketplaceOnly ?? false)
	const state: FakeState = {
		plugins:
			options.plugins ??
			(production
				? [
						{
							id: productionId,
							version: pluginVersion,
							scope: "user",
							enabled: options.productionEnabled ?? true,
							installPath: join(temporaryRoot, "production-install"),
						},
					]
				: []),
		marketplaces:
			options.marketplaces ??
			(productionMarketplace
				? [
						{
							name: pluginName,
							source: "directory",
							path: productionMarketplaceRoot,
							installLocation: productionMarketplaceRoot,
						},
					]
				: []),
		commands: [],
		failCommands: options.failCommands,
		failAfterCommands: options.failAfterCommands,
	}
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
	const environment = {
		...process.env,
		HOME: join(temporaryRoot, "home"),
		CLAUDE_CONFIG_DIR: profileRoot,
		FAKE_CLAUDE_STATE: statePath,
		PATH: `${binaryRoot}:${process.env.PATH ?? ""}`,
	}
	const profileKey = createHash("sha256").update(resolve(profileRoot)).digest("hex").slice(0, 16)
	const snapshotPath = join(root, ".dev", "claude", "restore-state", `${profileKey}.json`)
	return {
		temporaryRoot,
		profileRoot,
		productionMarketplaceRoot,
		environment,
		snapshotPath,
		readState: () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState,
		writeState: (nextState: FakeState) =>
			writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`),
		cleanup: () => {
			rmSync(temporaryRoot, { recursive: true, force: true })
			rmSync(snapshotPath, { force: true })
		},
	}
}

function jsonOutput(result: ReturnType<typeof run>): any {
	return JSON.parse(result.stdout.toString())
}

test("Claude development help exposes persistent lifecycle actions", () => {
	const result = run(["claude", "--help"])

	expect(result.exitCode).toBe(0)
	const output = result.stdout.toString()
	for (const action of ["check", "install", "restore", "watch"]) {
		expect(output).toContain(action)
	}
	expect(output).not.toContain("--plugin-dir")
})

test("invalid Claude lifecycle usage exits with the input-error status", () => {
	const result = run(["claude", "check", "--apply"])

	expect(result.exitCode).toBe(2)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toContain("--apply is supported only")
})

test("Claude check has one non-interactive JSON process contract", () => {
	const result = run(["claude", "check", "--json", "--no-input"])

	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	const output = JSON.parse(result.stdout.toString())
	expect(output).toMatchObject({
		schemaVersion: 1,
		contractId: "plugin.development-installation",
		ok: true,
		harness: "claude",
		operation: "check",
		mode: "inspect",
		changed: false,
		retrySafety: "safe",
	})
	expect(output.runId).toBeString()
	expect(output.nextAction).toBeString()
})

test("dev:claude is the build-only watch shortcut", () => {
	const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

	expect(packageJson.scripts["dev:claude"]).toBe("bun run scripts/dev.ts claude watch")
})

test("Codex development dry-run remains the native staged reinstall plan", () => {
	const result = run(["codex", "--dry-run", "--json"])

	expect(result.exitCode).toBe(0)
	const output = JSON.parse(result.stdout.toString())
	expect(output.harness).toBe("codex")
	expect(output.install).toContain("codex plugin add")
	expect(output.reload).toBe("Start a fresh Codex task after reinstall")
})

test("Claude development watches workspace, runtime, manifest, and lock inputs", () => {
	const recursivePaths = new Set(
		claudeWatchSources.filter(({ recursive }) => recursive).map(({ relativePath }) => relativePath),
	)
	const filePaths = new Set(
		claudeWatchSources
			.filter(({ recursive }) => !recursive)
			.map(({ relativePath }) => relativePath),
	)

	for (const relativePath of [
		"runtime",
		"packages",
		"plugin/skills",
		"plugin/hooks",
		"plugin/assets",
		"plugin/.claude-plugin",
		"plugin/.codex-plugin",
	]) {
		expect(recursivePaths.has(relativePath)).toBe(true)
	}
	for (const relativePath of ["package.json", "bun.lock", "bunfig.toml", "plugin.config.json"]) {
		expect(filePaths.has(relativePath)).toBe(true)
	}
})

test("Claude check generates a link-mode command source for the canonical payload", () => {
	const result = run(["claude", "check", "--json", "--no-input"])
	expect(result.exitCode).toBe(0)
	const marketplace = JSON.parse(
		readFileSync(
			join(root, ".dev", "claude", "marketplace", ".claude-plugin", "marketplace.json"),
			"utf8",
		),
	)
	expect(marketplace.name).toBe(developmentMarketplaceName)
	expect(marketplace.plugins).toHaveLength(1)
	expect(marketplace.plugins[0]).toMatchObject({
		name: pluginName,
		defaultEnabled: false,
		source: {
			source: "command",
			mode: "link",
		},
	})
	expect(marketplace.plugins[0].source.command).toContain(join(root, "plugin"))
})

test("install preview reports the transition without changing Claude profile state", () => {
	const profile = fakeProfile({ production: true })
	try {
		const result = run(["claude", "install", "--json", "--no-input"], profile.environment)

		expect(result.exitCode).toBe(0)
		expect(jsonOutput(result)).toMatchObject({
			ok: true,
			mode: "preview",
			changed: false,
			transactionState: "previewed",
			current: {
				production: "installed",
				development: "absent",
				singleSource: true,
			},
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(
			commands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
		expect(commands.some((command) => command.includes("marketplace add"))).toBe(false)
		expect(commands.some((command) => command.includes("marketplace remove"))).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("install and restore preserve an originally absent production state", () => {
	const profile = fakeProfile()
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		expect(jsonOutput(installed)).toMatchObject({
			transactionState: "installed",
			changed: true,
			current: {
				production: "absent",
				development: "installed",
				singleSource: true,
				linkedToCanonicalPayload: true,
			},
		})
		const development = profile.readState().plugins.find((plugin) => plugin.id === developmentId)
		expect(development?.enabled).toBe(true)
		expect(existsSync(development!.installPath)).toBe(true)

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(restored.exitCode).toBe(0)
		expect(jsonOutput(restored)).toMatchObject({
			transactionState: "restored",
			current: {
				production: "absent",
				development: "absent",
				singleSource: true,
			},
		})
		expect(profile.readState().plugins).toHaveLength(0)
		expect(profile.readState().marketplaces).toHaveLength(0)
	} finally {
		profile.cleanup()
	}
})

test("install and restore preserve a production Marketplace without an installed plugin", () => {
	const profile = fakeProfile({ productionMarketplaceOnly: true })
	try {
		const preview = run(["claude", "install", "--json", "--no-input"], profile.environment)
		expect(preview.exitCode).toBe(0)
		expect(jsonOutput(preview).current.production).toBe("marketplace-only")

		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		expect(jsonOutput(installed).current).toMatchObject({
			production: "absent",
			development: "installed",
			singleSource: true,
		})

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(restored.exitCode).toBe(0)
		expect(jsonOutput(restored).current).toMatchObject({
			production: "marketplace-only",
			development: "absent",
			singleSource: true,
		})
		expect(profile.readState().plugins).toHaveLength(0)
		expect(profile.readState().marketplaces).toHaveLength(1)
		expect(profile.readState().marketplaces[0].path).toBe(profile.productionMarketplaceRoot)
	} finally {
		profile.cleanup()
	}
})

test("isolated profile snapshots cannot overwrite each other's restore state", () => {
	const productionProfile = fakeProfile({ production: true, productionEnabled: false })
	const absentProfile = fakeProfile()
	try {
		for (const profile of [productionProfile, absentProfile]) {
			const installed = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(installed.exitCode).toBe(0)
		}

		const productionRestored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			productionProfile.environment,
		)
		expect(productionRestored.exitCode).toBe(0)
		expect(jsonOutput(productionRestored).current.production).toBe("installed")
		expect(productionProfile.readState().plugins[0].enabled).toBe(false)

		const absentRestored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			absentProfile.environment,
		)
		expect(absentRestored.exitCode).toBe(0)
		expect(jsonOutput(absentRestored).current.production).toBe("absent")
		expect(absentProfile.readState().plugins).toHaveLength(0)
	} finally {
		productionProfile.cleanup()
		absentProfile.cleanup()
	}
})

test("relative production Marketplace paths block before profile mutation", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: pluginName,
				source: "directory",
				path: "relative-marketplace",
				installLocation: "relative-marketplace",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: false,
			error: { code: "PRODUCTION_SOURCE_UNRESTORABLE" },
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(commands.some((command) => command.includes("marketplace remove"))).toBe(false)
	} finally {
		profile.cleanup()
	}
})

for (const productionEnabled of [true, false]) {
	test(`install and restore preserve production enabled=${productionEnabled}`, () => {
		const profile = fakeProfile({ production: true, productionEnabled })
		const sentinel = join(
			profile.profileRoot,
			"plugins",
			"data",
			productionId,
			"restoration-sentinel.txt",
		)
		mkdirSync(join(sentinel, ".."), { recursive: true })
		writeFileSync(sentinel, "preserve me\n")
		try {
			const installed = run(
				["claude", "install", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(installed.exitCode).toBe(0)
			let state = profile.readState()
			expect(state.plugins.map((plugin) => plugin.id)).toEqual([developmentId])
			const commandTexts = state.commands.map((command) => command.join(" "))
			expect(
				commandTexts.indexOf(`plugin uninstall ${productionId} --keep-data --scope user`),
			).toBeLessThan(
				commandTexts.indexOf(
					`plugin marketplace add ${join(root, ".dev", "claude", "marketplace")} --scope user`,
				),
			)

			const restored = run(
				["claude", "restore", "--apply", "--json", "--no-input"],
				profile.environment,
			)
			expect(restored.exitCode).toBe(0)
			state = profile.readState()
			expect(state.plugins).toHaveLength(1)
			expect(state.plugins[0]).toMatchObject({
				id: productionId,
				version: pluginVersion,
				scope: "user",
				enabled: productionEnabled,
			})
			expect(state.marketplaces).toHaveLength(1)
			expect(state.marketplaces[0].path).toBe(profile.productionMarketplaceRoot)
			expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n")
		} finally {
			profile.cleanup()
		}
	})
}

test("install is idempotent when the exact development link is already active", () => {
	const profile = fakeProfile()
	try {
		const first = run(["claude", "install", "--apply", "--json", "--no-input"], profile.environment)
		expect(first.exitCode).toBe(0)
		const before = profile.readState().commands.length
		const second = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(second.exitCode).toBe(0)
		expect(jsonOutput(second)).toMatchObject({
			changed: false,
			transactionState: "no_op",
		})
		const secondCommands = profile
			.readState()
			.commands.slice(before)
			.map((command) => command.join(" "))
		expect(
			secondCommands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("install previews and repairs a disabled snapshot-owned development link", () => {
	const profile = fakeProfile({ production: true, productionEnabled: false })
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		const disabled = profile.readState()
		disabled.plugins[0].enabled = false
		profile.writeState(disabled)

		const preview = run(["claude", "install", "--json", "--no-input"], profile.environment)
		expect(preview.exitCode).toBe(0)
		expect(jsonOutput(preview)).toMatchObject({
			changed: false,
			transactionState: "previewed",
			current: { development: "installed", linkedToCanonicalPayload: true },
		})
		expect(profile.readState().plugins[0].enabled).toBe(false)

		const repaired = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(repaired.exitCode).toBe(0)
		expect(jsonOutput(repaired)).toMatchObject({
			changed: true,
			transactionState: "installed",
			current: { development: "installed", linkedToCanonicalPayload: true },
		})
		expect(profile.readState().plugins[0].enabled).toBe(true)

		const restored = run(
			["claude", "restore", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(restored.exitCode).toBe(0)
		expect(profile.readState().plugins[0]).toMatchObject({
			id: productionId,
			version: pluginVersion,
			enabled: false,
		})
	} finally {
		profile.cleanup()
	}
})

test("an unmanaged development link without its profile snapshot fails closed", () => {
	const profile = fakeProfile()
	try {
		const installed = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(installed.exitCode).toBe(0)
		rmSync(profile.snapshotPath, { force: true })

		const checked = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(checked.exitCode).toBe(1)
		expect(jsonOutput(checked)).toMatchObject({
			ok: false,
			changed: false,
			retrySafety: "inspect_required",
			error: { code: "RESTORATION_SNAPSHOT_MISSING", action: "INSPECT_STATE" },
		})
	} finally {
		profile.cleanup()
	}
})

test("non-user plugin scope blocks before any profile mutation", () => {
	const profile = fakeProfile({
		plugins: [
			{
				id: productionId,
				version: pluginVersion,
				scope: "project",
				enabled: true,
				installPath: "/isolated/project-install",
			},
		],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: false,
			transactionState: "blocked",
			error: { code: "NON_USER_PLUGIN_IDENTITY", action: "ASK_ADMIN" },
		})
		const commands = profile.readState().commands.map((command) => command.join(" "))
		expect(
			commands.some((command) => /plugin (install|uninstall|enable|disable)/.test(command)),
		).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("simultaneous production and development sources block before mutation", () => {
	const wrongDevelopmentRoot = join(tmpdir(), "wrong-development-install")
	const profile = fakeProfile({ production: true })
	const state = profile.readState()
	state.plugins.push({
		id: developmentId,
		version: `${pluginVersion}-fake-link`,
		scope: "user",
		enabled: true,
		installPath: wrongDevelopmentRoot,
	})
	state.marketplaces.push({
		name: developmentMarketplaceName,
		source: "directory",
		path: join(root, ".dev", "claude", "marketplace"),
		installLocation: join(root, ".dev", "claude", "marketplace"),
	})
	writeFileSync(join(profile.temporaryRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result).error.code).toBe("DUPLICATE_PLUGIN_SOURCES")
		expect(jsonOutput(result).changed).toBe(false)
	} finally {
		profile.cleanup()
	}
})

test("development Marketplace ownership mismatch blocks fail closed", () => {
	const profile = fakeProfile({
		marketplaces: [
			{
				name: developmentMarketplaceName,
				source: "directory",
				path: "/another/checkout/marketplace",
				installLocation: "/another/checkout/marketplace",
			},
		],
	})
	try {
		const result = run(["claude", "check", "--json", "--no-input"], profile.environment)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result).error.code).toBe("DEVELOPMENT_MARKETPLACE_MISMATCH")
	} finally {
		profile.cleanup()
	}
})

test("failed development install restores the exact production state", () => {
	const profile = fakeProfile({
		production: true,
		productionEnabled: false,
		failCommands: [`plugin install ${developmentId} --scope user --yes`],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			operation: "install",
			mode: "apply",
			changed: true,
			transactionState: "restored",
			retrySafety: "safe",
			error: { code: "INSTALL_FAILED_RESTORED" },
		})
		const state = profile.readState()
		expect(state.plugins).toHaveLength(1)
		expect(state.plugins[0]).toMatchObject({
			id: productionId,
			version: pluginVersion,
			enabled: false,
		})
		expect(state.marketplaces).toHaveLength(1)
		expect(state.marketplaces[0].name).toBe(pluginName)
	} finally {
		profile.cleanup()
	}
})

test("a mutation that changes state before exiting nonzero is still restored", () => {
	const profile = fakeProfile({
		production: true,
		productionEnabled: true,
		failAfterCommands: [`plugin uninstall ${productionId} --keep-data --scope user`],
	})
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			transactionState: "restored",
			retrySafety: "safe",
			error: { code: "INSTALL_FAILED_RESTORED" },
		})
		const state = profile.readState()
		expect(state.plugins).toHaveLength(1)
		expect(state.plugins[0]).toMatchObject({
			id: productionId,
			version: pluginVersion,
			enabled: true,
		})
		expect(state.marketplaces).toHaveLength(1)
	} finally {
		profile.cleanup()
	}
})

test("failed installation and failed rollback report inspect-required unknown state", () => {
	const profile = fakeProfile({
		production: true,
		failCommands: [
			`plugin install ${developmentId} --scope user --yes`,
			// The first add is development; the directory source add below occurs only during rollback.
			`plugin marketplace add PLACEHOLDER --scope user`,
		],
	})
	const state = profile.readState()
	state.failCommands![1] = `plugin marketplace add ${profile.productionMarketplaceRoot} --scope user`
	writeFileSync(join(profile.temporaryRoot, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
	try {
		const result = run(
			["claude", "install", "--apply", "--json", "--no-input"],
			profile.environment,
		)
		expect(result.exitCode).toBe(1)
		expect(jsonOutput(result)).toMatchObject({
			ok: false,
			changed: true,
			transactionState: "unknown",
			retrySafety: "inspect_required",
			error: {
				code: "INSTALL_AND_RESTORATION_FAILED",
				action: "INSPECT_STATE",
				safeToRetrySameInput: false,
			},
		})
	} finally {
		profile.cleanup()
	}
})
