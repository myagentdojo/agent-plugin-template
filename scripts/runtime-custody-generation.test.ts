import { existsSync, readFileSync, readdirSync } from "node:fs"
import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

function runGenerateCheck(): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "generate:check"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("one Bun version is pinned across packageManager, bun.lock, CI, and the runtime lock", async () => {
	const lock = await Bun.file(new URL("../runtime/runtime.lock.json", import.meta.url)).json()
	const bunVersion: string = lock.profiles.bun.version

	const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()
	expect(packageJson.packageManager).toBe(`bun@${bunVersion}`)

	expect(await Bun.file(new URL("../bun.lock", import.meta.url)).exists()).toBe(true)

	const workflowsDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url))
	const workflowFiles = readdirSync(workflowsDirectory).filter((name) => name.endsWith(".yml"))
	expect(workflowFiles.length).toBeGreaterThan(0)
	let pinnedWorkflows = 0
	for (const workflowFile of workflowFiles) {
		const workflow = readFileSync(`${workflowsDirectory}${workflowFile}`, "utf8")
		const setupCount = [...workflow.matchAll(/uses:\s*oven-sh\/setup-bun/g)].length
		const pins = [...workflow.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1])
		// Non-vacuous gate: a workflow that runs Bun must set it up, and every
		// setup must carry exactly one pin at the locked version.
		if (/\bbun\s+(?:run|test|add|install|x)\b/.test(workflow)) {
			expect(`${workflowFile} sets up Bun ${setupCount > 0}`).toBe(`${workflowFile} sets up Bun true`)
		}
		expect(`${workflowFile} pins ${pins.length} of ${setupCount} setups`).toBe(
			`${workflowFile} pins ${setupCount} of ${setupCount} setups`,
		)
		for (const pin of pins) {
			expect(`${workflowFile} pins bun-version ${pin}`).toBe(
				`${workflowFile} pins bun-version ${bunVersion}`,
			)
		}
		if (pins.length > 0) pinnedWorkflows += 1
	}
	expect(pinnedWorkflows).toBeGreaterThan(0)
})

test("runtime custody sources generate one thin launcher and checked shell projections", async () => {
	const check = runGenerateCheck()
	expect(check.exitCode).toBe(0)

	const lock = await Bun.file(new URL("../runtime/runtime.lock.json", import.meta.url)).json()
	expect(lock).toMatchObject({
		schemaVersion: 1,
		profiles: {
			bun: {
				version: "1.3.14",
			},
		},
	})
	expect(Object.keys(lock.profiles.bun.assets).sort()).toEqual([
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64",
		"linux-x64",
	])

	const catalog = await Bun.file(
		new URL("../runtime/skill-catalog.json", import.meta.url),
	).json()
	expect(catalog).toEqual({
		schemaVersion: 1,
		skills: {
			"hello-world": {
				entry: "runtime/hello-world.js",
				runtimeProfile: "bun",
			},
			"skill-a": {
				entry: "runtime/skill-a.js",
				runtimeProfile: "bun",
				workspace: "packages/skill-a",
			},
			"skill-b": {
				entry: "runtime/skill-b.js",
				runtimeProfile: "bun",
				workspace: "packages/skill-b",
			},
		},
	})
	const installedSkills = readdirSync(
		fileURLToPath(new URL("../plugin/skills", import.meta.url)),
	).sort()
	expect(installedSkills).toEqual([
		"capability-tour",
		"hello-world",
		"runtime-custody",
		"skill-a",
		"skill-b",
	])
	expect(catalog.skills).not.toHaveProperty("capability-tour")

	// One logical catalog owns workspace, SKILL, and runtime identity per skill.
	for (const [skillId, skill] of Object.entries(
		catalog.skills as Record<string, { workspace?: string }>,
	)) {
		expect(
			existsSync(fileURLToPath(new URL(`../plugin/skills/${skillId}/SKILL.md`, import.meta.url))),
		).toBe(true)
		if (skill.workspace) {
			expect(
				existsSync(fileURLToPath(new URL(`../${skill.workspace}/package.json`, import.meta.url))),
			).toBe(true)
		}
	}

	// Every logical catalog member is active through one generated custody launcher.
	const { renderRuntimeCustodyFiles } = await import("./runtime-custody-config")
	const generated = renderRuntimeCustodyFiles(fileURLToPath(new URL("..", import.meta.url)))
	for (const skillId of Object.keys(catalog.skills)) {
		const launcher = await Bun.file(new URL(`../plugin/bin/${skillId}`, import.meta.url)).text()
		expect(launcher).toContain(`runtime-exec\" run ${skillId} --`)
		expect(launcher).not.toContain("hooks/")
		const skillDocument = await Bun.file(
			new URL(`../plugin/skills/${skillId}/SKILL.md`, import.meta.url),
		).text()
		expect(skillDocument).not.toContain("Status: not yet invocable")
	}
	expect(generated.filter((file) => file.path.startsWith("plugin/bin/")).length).toBe(3)
	const launcherNames = readdirSync(
		fileURLToPath(new URL("../plugin/bin", import.meta.url)),
	).sort()
	expect(launcherNames).toEqual(["hello-world", "skill-a", "skill-b"])
	const bundleInventory = await Bun.file(
		new URL("../plugin/runtime/bundle-inventory.json", import.meta.url),
	).json()
	expect(Object.keys(bundleInventory.bundles).sort()).toEqual(["hello-world", "skill-a", "skill-b"])
	expect(bundleInventory.bundles).not.toHaveProperty("capability-tour")

	const lockProjection = await Bun.file(
		new URL("../plugin/runtime/runtime-lock.sh", import.meta.url),
	).text()
	expect(lockProjection).toContain("Generated from runtime/runtime.lock.json")
	expect(lockProjection).toContain("RUNTIME_LOCK_VERSION='1.3.14'")

	const catalogProjection = await Bun.file(
		new URL("../plugin/runtime/skill-catalog.sh", import.meta.url),
	).text()
	expect(catalogProjection).toContain("Generated from runtime/skill-catalog.json")
	expect(catalogProjection).toContain("RUNTIME_SKILL_ENTRY='runtime/hello-world.js'")
})
