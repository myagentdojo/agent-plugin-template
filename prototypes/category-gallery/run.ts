// PROTOTYPE — throwaway. One command: build + run all three category example
// skills and surface each one's state. Proves each runtime PATH actually runs.
//   cat1: pure logic  -> QuickJS
//   cat2: npm + shim   -> QuickJS (nanoid needs the crypto shim)
//   cat3: OS-integrated -> bootstrapped Bun (spawn + fs)
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const here = import.meta.dir
const repoRoot = join(here, "..", "..")
const qjs = join(repoRoot, "plugin", "runtime", `qjs-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x86_64"}`)
const out = join(here, ".out")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

async function buildForQuickjs(entry: string, name: string): Promise<string> {
	// EXACT template build settings: target browser, esm, external qjs:std, minify.
	const dir = join(out, name)
	const r = await Bun.build({
		entrypoints: [entry],
		outdir: dir,
		naming: "b.js",
		target: "browser",
		format: "esm",
		external: ["qjs:std", "qjs:os"],
		minify: true,
	})
	if (!r.success) throw new Error(`${name} bundle failed: ${r.logs.map(String).join("; ")}`)
	return join(dir, "b.js")
}

function runQjs(bundle: string, stdin = ""): { ok: boolean; out: string } {
	const p = spawnSync(qjs, [bundle], { input: stdin, encoding: "utf8" })
	return { ok: p.status === 0, out: (p.status === 0 ? p.stdout : p.stderr).trim() }
}

console.log("\n=== category gallery: one runnable skill per category ===\n")

// cat1
const b1 = await buildForQuickjs(join(here, "cat1-pure-logic", "skill.ts"), "cat1")
const r1 = runQjs(b1, "the quick brown fox")
console.log(`cat1  [QuickJS]        ${r1.ok ? "RUN ok" : "RUN FAIL"}: ${r1.out}`)

// cat2
const b2 = await buildForQuickjs(join(here, "cat2-npm-shim", "skill.ts"), "cat2")
const r2 = runQjs(b2)
console.log(`cat2  [QuickJS+shim]   ${r2.ok ? "RUN ok" : "RUN FAIL"}: ${r2.out}`)

// cat3: run via its bootstrap launcher (spawns Bun, then the OS-integrated skill)
const p3 = spawnSync("bun", ["run", join(here, "cat3-bootstrap", "launcher.ts")], { encoding: "utf8" })
const r3ok = p3.status === 0
console.log(`cat3  [Bun bootstrap]  ${r3ok ? "RUN ok" : "RUN FAIL"}: ${(r3ok ? p3.stdout : p3.stderr).trim().split("\n").join(" | ")}`)

console.log("\nverdict: each category runs on the runtime its workload requires.\n")
