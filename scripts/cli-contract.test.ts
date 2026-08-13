import { expect, test } from "bun:test"

const root = new URL("..", import.meta.url).pathname

function run(arguments_: string[]): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", ...arguments_],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("template CLI discovery and rendered help expose the same public commands", async () => {
	const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json()
	expect(packageJson.scripts).toMatchObject({
		init: "bun run scripts/init.ts",
		"release:validate": "bun run scripts/release-validate.ts",
		"ship:canary": "bun run scripts/ship-canary.ts",
		update: "bun run scripts/update.ts",
	})

	const updateHelp = run(["update", "--", "--help"])
	expect(updateHelp.exitCode).toBe(0)
	expect(updateHelp.stdout.toString()).toContain("Preview by default")
	expect(updateHelp.stdout.toString()).toContain("--target latest|vX.Y.Z")
	expect(updateHelp.stdout.toString()).toContain("--apply")
	expect(updateHelp.stdout.toString()).toContain("refreshes the configured ref")
	expect(updateHelp.stdout.toString()).toContain("selects a newer immutable Release")

	const initHelp = run(["init", "--", "--help"])
	expect(initHelp.exitCode).toBe(0)
	expect(initHelp.stdout.toString()).toContain("--dry-run")
	expect(initHelp.stdout.toString()).toContain("Side effects:")

	const canaryHelp = run(["ship:canary", "--", "--help"])
	expect(canaryHelp.exitCode).toBe(0)
	expect(canaryHelp.stdout.toString()).toContain("--execute")
	expect(canaryHelp.stdout.toString()).toContain("create-only compare-and-swap")
	expect(canaryHelp.stdout.toString()).toContain("never replaced or deleted")

	const releaseHelp = run(["release:validate", "--", "--help"])
	expect(releaseHelp.exitCode).toBe(0)
	expect(releaseHelp.stdout.toString()).toContain("Validate release metadata")
	expect(releaseHelp.stdout.toString()).toContain("Side effects: none")
})

test("init usage failure is structured for scripts and agents", () => {
	const result = run(["init", "--", "--unknown", "--json"])
	expect(result.exitCode).toBe(2)
	const failure = JSON.parse(result.stdout.toString().trim())
	expect(failure).toMatchObject({
		ok: false,
		category: "usage",
		retrySafe: true,
		nextAction: "bun run init -- --help",
	})
	expect(failure.runId).toBeString()
})

test("artifact download does not depend on a checked-out git repository", async () => {
	const workflow = await Bun.file(
		new URL("../.github/workflows/plugin-ci.yml", import.meta.url),
	).text()
	expect(workflow).toContain(
		'gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY"',
	)
})
