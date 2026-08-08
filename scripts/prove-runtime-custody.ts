import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const negativeSuiteFile = "scripts/runtime-custody-exec.test.ts"

// Step 1: the exhaustive negative suite is the custody behavior proof,
// including concurrency, interruption, and killed-writer coverage.
const suite = Bun.spawnSync({
	cmd: [process.execPath, "test", negativeSuiteFile],
	cwd: root,
	env: { ...process.env },
	stdout: "inherit",
	stderr: "inherit",
})
if (suite.exitCode !== 0) process.exit(suite.exitCode ?? 1)

// Step 2: real-payload smoke. The checked-in engine and projections run
// against an isolated empty private store; nothing here touches the network.
const isolationRoot = mkdtempSync(join(tmpdir(), "runtime-custody-proof-"))
chmodSync(isolationRoot, 0o700)
const cacheRoot = join(isolationRoot, "cache")
mkdirSync(cacheRoot, { mode: 0o700 })

interface Envelope {
	schemaVersion: number
	ok: boolean
	code: string
	sideEffects: string[]
	retrySafe: boolean
	nextAction: string
}

function runEngine(args: string[]): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [join(root, "plugin", "runtime", "runtime-exec"), ...args],
		cwd: root,
		env: {
			HOME: isolationRoot,
			XDG_CACHE_HOME: cacheRoot,
			PATH: "/usr/bin:/bin",
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

function requireEnvelope(
	step: string,
	result: ReturnType<typeof Bun.spawnSync>,
	expected: { exitCode: number; ok: boolean; code: string },
): Envelope {
	if (result.exitCode !== expected.exitCode) {
		throw new Error(
			`${step}: expected exit ${expected.exitCode}, received ${result.exitCode}\n${result.stderr.toString()}`,
		)
	}
	const lines = result.stdout.toString().trim().split("\n")
	if (lines.length !== 1) {
		throw new Error(`${step}: expected exactly one JSON control line, received ${lines.length}`)
	}
	const envelope = JSON.parse(lines[0]) as Envelope
	if (envelope.ok !== expected.ok || envelope.code !== expected.code) {
		throw new Error(
			`${step}: expected ok=${expected.ok} code=${expected.code}, received ok=${envelope.ok} code=${envelope.code}`,
		)
	}
	return envelope
}

try {
	const run = requireEnvelope("run skill-a with empty store", runEngine(["run", "skill-a"]), {
		exitCode: 20,
		ok: false,
		code: "BUN_MISSING",
	})
	if (run.sideEffects.length !== 0) {
		throw new Error(`run skill-a reported side effects: ${JSON.stringify(run.sideEffects)}`)
	}

	const preview = requireEnvelope("repair preview with empty store", runEngine(["repair"]), {
		exitCode: 0,
		ok: true,
		code: "REPAIR_PREVIEW",
	})
	if (preview.sideEffects.length !== 0) {
		throw new Error(`repair preview reported side effects: ${JSON.stringify(preview.sideEffects)}`)
	}

	// Read-only proof: run and preview left the isolated store untouched.
	const residue = readdirSync(cacheRoot)
	if (residue.length !== 0) {
		throw new Error(`isolated store is no longer empty: ${JSON.stringify(residue)}`)
	}

	console.log(
		JSON.stringify({
			ok: true,
			negativeSuite: { file: negativeSuiteFile, exitCode: 0 },
			smoke: {
				run: { exitCode: 20, code: "BUN_MISSING" },
				repairPreview: { exitCode: 0, code: "REPAIR_PREVIEW" },
				isolatedStoreEmpty: true,
			},
			sideEffects: "none",
		}),
	)
} finally {
	rmSync(isolationRoot, { recursive: true, force: true })
}
