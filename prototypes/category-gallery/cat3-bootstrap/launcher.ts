// PROTOTYPE — throwaway. Category 3 bootstrap launcher (ADR 0004 Option B).
// Resolve a pinned Bun runtime into a cache (reuse-if-present, else fetch),
// then run the OS-integrated skill on it. This proves the BOOTSTRAP MECHANISM;
// the actual network fetch is stubbed (marked) — a production version would
// download a checksum-pinned Bun like quickjs-assets.json pins qjs.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

interface RuntimePin {
	name: string
	version: string
	// In production: per-platform URL + sha256, mirroring plugin/runtime/quickjs-assets.json.
	source: string
}

const pin: RuntimePin = {
	name: "bun",
	version: "pinned-vX.Y.Z",
	source: "https://bun.sh/download (checksum-pinned per platform in production)",
}

const cacheDir = join(homedir(), ".cache", "category-gallery-runtime")
mkdirSync(cacheDir, { recursive: true })

function resolveRuntime(): { path: string; origin: "reused-present" | "fetched-pinned" } {
	// 1) Reuse an already-present runtime if custody can be proven.
	const present = spawnSync("bun", ["--version"], { encoding: "utf8" })
	if (present.status === 0) {
		return { path: "bun", origin: "reused-present" }
	}
	// 2) Otherwise fetch the pinned runtime into the cache (STUBBED here).
	//    Production: download pin.source, verify sha256, chmod +x, cache it.
	throw new Error(
		`bootstrap: no runtime present; would fetch pinned ${pin.name}@${pin.version} into ${cacheDir} and verify its checksum`,
	)
}

const skill = join(import.meta.dir, "skill.ts")
const runtime = resolveRuntime()
console.log(`[bootstrap] runtime=${pin.name}@${pin.version} origin=${runtime.origin} cache=${cacheDir}`)
const run = spawnSync(runtime.path, ["run", skill], { encoding: "utf8", stdio: "inherit" })
process.exit(run.status ?? 1)
