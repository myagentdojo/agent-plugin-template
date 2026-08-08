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
import { join } from "node:path"

import { afterEach, expect, test } from "bun:test"

import { loadSkillCatalog, renderRuntimeCustodyFiles } from "./runtime-custody-config"

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const temporaryRoots: string[] = []

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

// biome-ignore lint/suspicious/noExplicitAny: fixtures mutate arbitrary JSON fields
function custodyFixture(mutate: (lock: any, catalog: any) => void): string {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "custody-config-"))
	temporaryRoots.push(fixtureRoot)
	mkdirSync(join(fixtureRoot, "runtime"), { recursive: true })
	const lock = JSON.parse(readFileSync(join(root, "runtime", "runtime.lock.json"), "utf8"))
	const catalog = JSON.parse(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8"))
	mutate(lock, catalog)
	writeFileSync(
		join(fixtureRoot, "runtime", "runtime.lock.json"),
		`${JSON.stringify(lock, null, 2)}\n`,
	)
	writeFileSync(
		join(fixtureRoot, "runtime", "skill-catalog.json"),
		`${JSON.stringify(catalog, null, 2)}\n`,
	)
	return fixtureRoot
}

test("the unmodified lock and catalog validate", () => {
	expect(() => loadSkillCatalog(custodyFixture(() => {}))).not.toThrow()
})

test("renders one custody launcher for every catalog skill", () => {
	const files = renderRuntimeCustodyFiles(root)
	const launchers = files
		.filter((file) => file.path.startsWith("plugin/bin/"))
		.map((file) => file.path)

	expect(launchers).toEqual([
		"plugin/bin/hello-world",
		"plugin/bin/skill-a",
		"plugin/bin/skill-b",
	])
	for (const launcher of files.filter((file) => file.path.startsWith("plugin/bin/"))) {
		expect(launcher.contents).toContain('exec "$plugin_root/runtime/runtime-exec" run')
	}
})

test("generated launchers resolve the plugin without trusting PATH", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "custody-launcher-"))
	temporaryRoots.push(fixtureRoot)
	const pluginRoot = join(fixtureRoot, "plugin")
	const binDirectory = join(pluginRoot, "bin")
	const runtimeDirectory = join(pluginRoot, "runtime")
	const hostileBin = join(fixtureRoot, "hostile-bin")
	mkdirSync(binDirectory, { recursive: true })
	mkdirSync(runtimeDirectory, { recursive: true })
	mkdirSync(hostileBin)

	const launcher = renderRuntimeCustodyFiles(root).find(
		(file) => file.path === "plugin/bin/skill-a",
	)
	if (!launcher) throw new Error("skill-a launcher was not rendered")
	const launcherPath = join(binDirectory, "skill-a")
	writeFileSync(launcherPath, launcher.contents)
	chmodSync(launcherPath, 0o755)

	const enginePath = join(runtimeDirectory, "runtime-exec")
	writeFileSync(enginePath, '#!/bin/sh\nprintf "%s\\n" "$*"\n')
	chmodSync(enginePath, 0o755)
	const sentinelPath = join(fixtureRoot, "dirname-ran")
	const hostileDirname = join(hostileBin, "dirname")
	writeFileSync(hostileDirname, `#!/bin/sh\n: >'${sentinelPath}'\nexit 99\n`)
	chmodSync(hostileDirname, 0o755)

	const result = Bun.spawnSync({
		cmd: [launcherPath],
		env: { PATH: hostileBin },
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString().trim()).toBe("run skill-a --")
	expect(existsSync(sentinelPath)).toBe(false)
})

test("rejects a runtime lock schema version other than 1", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.schemaVersion = 2
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(/runtime lock schemaVersion must be 1/)
})

test("rejects a runtime lock carrying a profile besides bun", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.deno = lock.profiles.bun
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock must contain only the bun profile/,
	)
})

for (const [shape, value] of [
	["null", null],
	["array", []],
] as const) {
	test(`rejects runtime lock profiles with ${shape} shape`, () => {
		const fixtureRoot = custodyFixture((lock) => {
			lock.profiles = value
		})
		expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
			/runtime lock profiles must be an object/,
		)
	})
}

test("rejects a runtime lock version that is not an exact semantic version", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.version = "^1.3.14"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock bun version must be an exact semantic version/,
	)
})

for (const [shape, value] of [
	["null", null],
	["array", []],
] as const) {
	test(`rejects runtime lock assets with ${shape} shape`, () => {
		const fixtureRoot = custodyFixture((lock) => {
			lock.profiles.bun.assets = value
		})
		expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
			/runtime lock bun assets must be an object/,
		)
	})
}

test("rejects a runtime lock missing one of the four supported platforms", () => {
	const fixtureRoot = custodyFixture((lock) => {
		delete lock.profiles.bun.assets["linux-x64"]
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock must contain exactly the four supported platforms/,
	)
})

test("rejects a runtime lock carrying an unsupported platform", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["windows-x64"] = lock.profiles.bun.assets["linux-x64"]
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock must contain exactly the four supported platforms/,
	)
})

test("rejects non-positive archive bytes in asset metadata", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["darwin-arm64"].archiveBytes = 0
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock asset metadata is invalid for darwin-arm64/,
	)
})

test("rejects a malformed executable digest in asset metadata", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["linux-arm64"].executableSha256 = "ABC123"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock asset metadata is invalid for linux-arm64/,
	)
})

test("rejects an archive name that departs from the upstream identity", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["darwin-x64"].archiveName = "bun-custom.zip"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock asset identity is invalid for darwin-x64/,
	)
})

test("rejects a download URL that departs from the upstream identity", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["linux-x64"].url = "https://example.invalid/bun-linux-x64.zip"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock asset identity is invalid for linux-x64/,
	)
})

test("rejects an executable path that departs from the upstream identity", () => {
	const fixtureRoot = custodyFixture((lock) => {
		lock.profiles.bun.assets["linux-x64"].executablePath = "bin/bun"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/runtime lock asset identity is invalid for linux-x64/,
	)
})

test("rejects a skill catalog schema version other than 1", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.schemaVersion = 0
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(/skill catalog schemaVersion must be 1/)
})

test("rejects an empty skill catalog", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills = {}
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(/skill catalog must not be empty/)
})

for (const [shape, value] of [
	["null", null],
	["array", []],
] as const) {
	test(`rejects skill catalog skills with ${shape} shape`, () => {
		const fixtureRoot = custodyFixture((_lock, catalog) => {
			catalog.skills = value
		})
		expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
			/skill catalog skills must be an object/,
		)
	})
}

test("rejects an invalid skill catalog id", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills.Bad_Id = catalog.skills["hello-world"]
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(/skill catalog id is invalid: Bad_Id/)
})

test("rejects a skill entry outside the runtime payload shape", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills["hello-world"].entry = "../outside.js"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/skill catalog entry is invalid for hello-world/,
	)
})

test("rejects a skill runtime profile absent from the lock", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills["hello-world"].runtimeProfile = "node"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/skill catalog profile is unknown for hello-world/,
	)
})

test("rejects an inherited runtime profile key", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills["hello-world"].runtimeProfile = "constructor"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/skill catalog profile is unknown for hello-world/,
	)
})

test("rejects a skill workspace outside the packages shape", () => {
	const fixtureRoot = custodyFixture((_lock, catalog) => {
		catalog.skills["skill-a"].workspace = "../elsewhere/skill-a"
	})
	expect(() => loadSkillCatalog(fixtureRoot)).toThrow(
		/skill catalog workspace is invalid for skill-a/,
	)
})
