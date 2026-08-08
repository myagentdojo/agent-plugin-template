import { expect, test } from "bun:test"

const root = new URL("..", import.meta.url).pathname

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

	const workflowsDirectory = new URL("../.github/workflows/", import.meta.url).pathname
	const { readdirSync, readFileSync } = await import("node:fs")
	const workflowFiles = readdirSync(workflowsDirectory).filter((name) => name.endsWith(".yml"))
	expect(workflowFiles.length).toBeGreaterThan(0)
	for (const workflowFile of workflowFiles) {
		const workflow = readFileSync(`${workflowsDirectory}${workflowFile}`, "utf8")
		for (const match of workflow.matchAll(/bun-version:\s*(\S+)/g)) {
			expect(`${workflowFile} pins bun-version ${match[1]}`).toBe(
				`${workflowFile} pins bun-version ${bunVersion}`,
			)
		}
	}
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

	// One logical catalog owns workspace, SKILL, and runtime identity per skill.
	const { existsSync } = await import("node:fs")
	for (const [skillId, skill] of Object.entries(
		catalog.skills as Record<string, { workspace?: string }>,
	)) {
		expect(existsSync(new URL(`../plugin/skills/${skillId}/SKILL.md`, import.meta.url).pathname)).toBe(
			true,
		)
		if (skill.workspace) {
			expect(existsSync(new URL(`../${skill.workspace}/package.json`, import.meta.url).pathname)).toBe(
				true,
			)
		}
	}

	// Preflight gate: while launcher rendering is inactive, the checked-in
	// launcher stays spike-owned and must not target the missing custody engine.
	const launcher = await Bun.file(new URL("../plugin/bin/hello-world", import.meta.url)).text()
	expect(launcher).not.toContain("runtime-exec")

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
