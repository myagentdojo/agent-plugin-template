// PROTOTYPE — throwaway. Executable proof of the cat3 bootstrap.
// Run this and it PROVES the mechanism instead of documenting it:
//   1. bootstrap resolves + installs a pinned runtime into a CLEAN cache,
//   2. checksum-verifies it, runs the OS-integrated skill on the cached runtime,
//   3. a cache hit is recognized on a second run,
//   4. a tampered checksum FAILS CLOSED (the wrong binary never runs).
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { bootstrapRuntime, type RuntimePin } from "./launcher"

const results: Array<[string, boolean, string]> = []
function check(name: string, ok: boolean, detail: string) { results.push([name, ok, detail]) }

const ambientBun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim()
const realSha = createHash("sha256").update(readFileSync(ambientBun)).digest("hex")
const version = spawnSync(ambientBun, ["--version"], { encoding: "utf8" }).stdout.trim()
const platform = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`
const pin: RuntimePin = { name: "bun", version, platform, sha256: realSha, source: ambientBun }
const copy = (p: RuntimePin, dest: string) => { const { copyFileSync } = require("node:fs"); copyFileSync(p.source, dest) }

// 1) fresh bootstrap -> acquired + verified + skill runs on the cached runtime
const cache = mkdtempSync(join(tmpdir(), "cat3-prove-"))
try {
	const boot1 = bootstrapRuntime(pin, cache, copy)
	check("fresh bootstrap acquires + verifies", boot1.origin === "acquired", `origin=${boot1.origin}`)
	const run = spawnSync(boot1.runtimePath, ["run", join(import.meta.dir, "skill.ts")], { encoding: "utf8" })
	const ran = run.status === 0 && run.stdout.includes("spawned git")
	check("skill runs on cached runtime (spawn+fs)", ran, run.stdout.trim().split("\n").pop() ?? run.stderr.trim())

	// 2) second bootstrap -> cache hit (no re-acquire)
	const boot2 = bootstrapRuntime(pin, cache, () => { throw new Error("must not re-acquire on cache hit") })
	check("second bootstrap is a cache hit", boot2.origin === "cache-hit", `origin=${boot2.origin}`)

	// 3) tampered checksum -> fail closed
	let failedClosed = false
	const badPin: RuntimePin = { ...pin, sha256: "0".repeat(64) }
	const cache2 = mkdtempSync(join(tmpdir(), "cat3-prove-bad-"))
	try {
		bootstrapRuntime(badPin, cache2, copy)
	} catch (e) {
		failedClosed = /checksum mismatch/.test((e as Error).message)
	} finally {
		rmSync(cache2, { recursive: true, force: true })
	}
	check("tampered checksum fails closed", failedClosed, failedClosed ? "rejected wrong binary" : "DID NOT reject")
} finally {
	rmSync(cache, { recursive: true, force: true })
}

console.log("\n=== prove:cat3-bootstrap ===")
for (const [name, ok, detail] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`)
const allOk = results.every(([, ok]) => ok)
console.log(allOk ? "\nok: bootstrap proven by execution, not documentation.\n" : "\nFAILED\n")
process.exit(allOk ? 0 : 1)
