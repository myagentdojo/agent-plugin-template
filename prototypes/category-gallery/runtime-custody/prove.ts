// PROTOTYPE — throwaway. Proves the DRY bootstrap by EXECUTION:
//   1. generate launchers from the catalog (no hand-written bootstrap),
//   2. two DIFFERENT skills route through the ONE engine and run on bootstrapped Bun,
//   3. both share a SINGLE cached runtime (install once, reuse across all),
//   4. doctor reports healthy; repair rebuilds,
//   5. an unknown skill id fails closed,
//   6. a tampered checksum fails closed.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = import.meta.dir
const exec = join(here, "runtime-exec.sh")
const cache = mkdtempSync(join(tmpdir(), "rc-prove-cache-"))
const env = { ...process.env, RUNTIME_CUSTODY_CACHE: cache }
const rows: Array<[string, boolean, string]> = []
const ok = (n: string, c: boolean, d: string) => rows.push([n, c, d])
const sh = (args: string[], e = env) => spawnSync("sh", [exec, ...args], { encoding: "utf8", env: e })

try {
	// 1) generate launchers
	const gen = spawnSync("bun", ["run", join(here, "generate.ts")], { encoding: "utf8" })
	ok("generate produces launchers", gen.status === 0 && gen.stdout.includes("bin/chrome-drive"), gen.stdout.trim())

	// 2+3) both skills run through the one engine; count cached runtimes after
	const r1 = sh(["run", "chrome-drive", "--", "--flag"])
	ok("skill A runs on bootstrapped Bun", r1.status === 0 && r1.stdout.includes("spawned"), r1.stdout.trim() || r1.stderr.trim())
	const r2 = sh(["run", "live-fetch", "--", "--x"])
	ok("skill B runs on bootstrapped Bun", r2.status === 0 && r2.stdout.includes("wrote+read"), r2.stdout.trim() || r2.stderr.trim())
	// exactly ONE bun binary cached, shared by both skills
	const bins: string[] = []
	const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "bun") bins.push(p) } }
	walk(cache)
	ok("ONE runtime cached, shared by all skills", bins.length === 1, `${bins.length} bun binaries in cache`)

	// 4) doctor + repair
	const doc = sh(["doctor", "bun"])
	ok("doctor reports healthy", doc.status === 0 && doc.stdout.includes('"ok":true'), doc.stdout.trim())
	const rep = sh(["repair", "bun"])
	ok("repair rebuilds runtime", rep.status === 0 && rep.stdout.includes('"ok":true'), rep.stdout.trim())

	// 5) unknown skill fails closed
	const unk = sh(["run", "nope", "--"])
	ok("unknown skill fails closed", unk.status !== 0 && /unknown skill/.test(unk.stderr), unk.stderr.trim())

	// 6) tampered checksum fails closed: a fresh engine dir with a wrong-sha lock,
	//    a clean writable cache. The acquire path must reject the copied binary.
	const td = mkdtempSync(join(tmpdir(), "rc-tdir-"))
	const lock = JSON.parse(readFileSync(join(here, "runtime.lock.json"), "utf8"))
	lock.profiles.bun.assets["darwin-arm64"].executableSha256 = "0".repeat(64)
	writeFileSync(join(td, "runtime.lock.json"), JSON.stringify(lock))
	spawnSync("cp", [exec, join(td, "runtime-exec.sh")])
	spawnSync("cp", [join(here, "catalog.json"), join(td, "catalog.json")])
	spawnSync("cp", ["-R", join(here, "skills"), join(td, "skills")])
	spawnSync("chmod", ["+x", join(td, "runtime-exec.sh")])
	const tamperCache = mkdtempSync(join(tmpdir(), "rc-tamper-"))
	const tamper = spawnSync("sh", [join(td, "runtime-exec.sh"), "run", "chrome-drive", "--"],
		{ encoding: "utf8", env: { ...process.env, RUNTIME_CUSTODY_CACHE: tamperCache } })
	ok("tampered checksum fails closed", tamper.status !== 0 && /checksum mismatch/.test(tamper.stderr), (tamper.stderr.trim().split("\n").pop() || tamper.stdout.trim()))
	rmSync(tamperCache, { recursive: true, force: true }); rmSync(td, { recursive: true, force: true })
} finally {
	rmSync(cache, { recursive: true, force: true })
}

console.log("\n=== prove: DRY runtime-custody bootstrap ===")
for (const [n, c, d] of rows) console.log(`  ${c ? "PASS" : "FAIL"}  ${n} — ${d}`)
const allOk = rows.every(([, c]) => c)
console.log(allOk ? "\nok: one engine, one pin, generated launchers, shared cache — proven by running it.\n" : "\nFAILED\n")
process.exit(allOk ? 0 : 1)
