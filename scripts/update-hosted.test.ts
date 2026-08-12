import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { expect, test } from "bun:test"

import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const hostedTest = process.env.RUN_HOSTED_CODEX_UPDATE === "1" ? test : test.skip

function jsonCommand<T>(
	arguments_: string[],
	cwd: string,
	environment: Record<string, string | undefined>,
): T {
	const codexExecutable = Bun.which("codex")
	if (!codexExecutable) throw new Error("hosted update proof requires the native Codex CLI")
	const result = Bun.spawnSync({
		cmd: [codexExecutable, ...arguments_],
		cwd,
		env: environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	})
	if (result.exitCode !== 0) throw new Error("hosted native Codex command failed")
	return JSON.parse(result.stdout.toString()) as T
}

function publicUpdate(
	arguments_: string[],
	environment: Record<string, string | undefined>,
): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "update", "--", ...arguments_],
		cwd: root,
		env: environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	})
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	}
}

hostedTest.each([1, 2])(
	"hosted immutable-tag update run %d selects v0.1.1 from a fresh v0.1.0 installation",
	(runNumber) => {
		const pluginConfig = loadPluginConfig(root)
		const source =
			process.env.CODEX_UPDATE_HOSTED_SOURCE ?? `${pluginConfig.repository.replace(/\.git$/, "")}.git`
		const fromTag = process.env.CODEX_UPDATE_HOSTED_FROM ?? "v0.1.0"
		const targetTag = process.env.CODEX_UPDATE_HOSTED_TARGET ?? "v0.1.1"
		const temporaryRoot = mkdtempSync(join(tmpdir(), `hosted-codex-update-${runNumber}-`))
		const codeHome = join(temporaryRoot, "codex")
		const project = join(temporaryRoot, "project")
		mkdirSync(codeHome)
		mkdirSync(project)
		const environment = {
			...process.env,
			CODEX_HOME: codeHome,
			CI: "1",
			NO_COLOR: "1",
		}
		try {
			jsonCommand(
				["plugin", "marketplace", "add", source, "--ref", fromTag, "--json"],
				project,
				environment,
			)
			const freshInstall = jsonCommand<{ version: string; installedPath: string }>(
				["plugin", "add", `${pluginConfig.name}@${pluginConfig.name}`, "--json"],
				project,
				environment,
			)
			expect(freshInstall.version).toBe(fromTag.slice(1))

			const previewResult = publicUpdate(
				["--harness", "codex", "--target", targetTag, "--json", "--no-input"],
				environment,
			)
			expect(previewResult.exitCode, previewResult.stderr).toBe(0)
			const preview = JSON.parse(previewResult.stdout)
			expect(preview).toMatchObject({
				ok: true,
				mode: "preview",
				changed: false,
				wouldChange: true,
				prior: { ref: fromTag, version: fromTag.slice(1) },
				selectedRelease: { tag: targetTag, manifestVersion: targetTag.slice(1) },
				proof: {
					status: "target_preflight",
					marketplaceRelease: fromTag,
					installationRelease: fromTag,
					functionalProofRelease: targetTag,
					lineageMatched: false,
				},
			})

			const updateResult = publicUpdate(
				[
					"--harness",
					"codex",
					"--target",
					targetTag,
					"--apply",
					"--json",
					"--no-input",
				],
				environment,
			)
			expect(updateResult.exitCode, updateResult.stderr).toBe(0)
			const update = JSON.parse(updateResult.stdout)
			expect(update).toMatchObject({
				ok: true,
				mode: "apply",
				changed: true,
				transactionState: "updated",
				prior: { ref: fromTag, version: fromTag.slice(1) },
				selectedRelease: { tag: targetTag, manifestVersion: targetTag.slice(1) },
				resulting: { ref: targetTag, version: targetTag.slice(1) },
				proof: {
					kind: "in_place_update",
					status: "installed_match",
					freshInstall: "not_run",
					lineageMatched: true,
				},
			})

			const installed = jsonCommand<{ installed: Array<{ version: string }> }>(
				["plugin", "list", "--json"],
				project,
				environment,
			)
			expect(installed.installed[0]?.version).toBe(targetTag.slice(1))
		} finally {
			rmSync(temporaryRoot, { recursive: true, force: true })
		}
	},
	60_000,
)
