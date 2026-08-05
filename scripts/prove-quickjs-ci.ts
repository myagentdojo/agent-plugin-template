import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const workflowPath = join(root, ".github", "workflows", "plugin-ci.yml")

for (const command of [
	["bun", "run", "spike:quickjs:ci"],
	["bun", "run", "prove:distribution"],
]) {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: root,
		env: { ...process.env, CI: "true" },
		stdout: "inherit",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
}

const workflow = readFileSync(workflowPath, "utf8")
for (const required of [
	"ubuntu-24.04",
	"ubuntu-24.04-arm",
	"macos-15",
	"macos-15-intel",
	"bun run spike:quickjs:ci",
	"bun run prove:distribution",
	"actions/attest",
	"github.event.repository.private == false",
]) {
	if (!workflow.includes(required)) throw new Error(`plugin workflow is missing ${required}`)
}

const actionReferences = [...workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
	(match) => match[1],
)
if (actionReferences.some((reference) => !/^[a-f0-9]{40}$/.test(reference))) {
	throw new Error("plugin workflow contains an action that is not pinned to a commit SHA")
}

console.log(
	JSON.stringify({
		ok: true,
		matrix: ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
		deterministicPackage: true,
		attestation: "configured for public main repositories after the compatibility matrix passes",
	}),
)
