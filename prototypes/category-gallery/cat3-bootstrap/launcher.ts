// PROTOTYPE — throwaway. Category 3 bootstrap launcher (ADR 0004 Option B).
// Proves the FULL custody mechanism hermetically: resolve -> install into a
// clean cache -> checksum-verify against a pinned manifest -> run the skill on
// the CACHED runtime (not the ambient one). Only the network transport (where
// the bytes come from) is abstracted behind `acquire`, so the proof never
// depends on a live download.
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export interface RuntimePin {
	name: string
	version: string
	platform: string // e.g. darwin-arm64
	sha256: string
	// Production: a URL. Prototype: a local path to the pinned executable bytes.
	source: string
}

function currentPlatform(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64"
	return `${process.platform}-${arch}`
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/**
 * Resolve the pinned runtime into a clean cache and verify its checksum.
 * Reuses an already-cached, checksum-matching binary; otherwise acquires the
 * bytes (via the injected transport), verifies, and caches them. Fails closed
 * on a checksum mismatch — a corrupted or wrong binary never runs.
 */
export function bootstrapRuntime(
	pin: RuntimePin,
	cacheDir: string,
	acquire: (pin: RuntimePin, dest: string) => void,
): { runtimePath: string; origin: "cache-hit" | "acquired" } {
	mkdirSync(cacheDir, { recursive: true })
	const cached = join(cacheDir, `${pin.name}-${pin.version}-${pin.platform}`)

	if (existsSync(cached) && sha256File(cached) === pin.sha256) {
		return { runtimePath: cached, origin: "cache-hit" }
	}

	acquire(pin, cached) // transport: copy/download the pinned bytes into place
	const got = sha256File(cached)
	if (got !== pin.sha256) {
		throw new Error(`bootstrap: checksum mismatch for ${pin.name}@${pin.version} (${pin.platform}): expected ${pin.sha256}, got ${got}`)
	}
	chmodSync(cached, 0o755)
	return { runtimePath: cached, origin: "acquired" }
}

// CLI entry: bootstrap using the PRESENT bun as the pinned source (real bytes,
// real checksum), into a scratch cache, then run the OS-integrated skill on it.
if (import.meta.main) {
	const ambientBun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim()
	if (!ambientBun) throw new Error("no bun found to pin for the prototype")
	const pin: RuntimePin = {
		name: "bun",
		version: spawnSync(ambientBun, ["--version"], { encoding: "utf8" }).stdout.trim(),
		platform: currentPlatform(),
		sha256: sha256File(ambientBun),
		source: ambientBun,
	}
	const cacheDir = join(process.env.CAT3_CACHE ?? join(import.meta.dir, ".runtime-cache"))
	const { runtimePath, origin } = bootstrapRuntime(pin, cacheDir, (p, dest) => copyFileSync(p.source, dest))
	console.log(`[bootstrap] ${pin.name}@${pin.version} ${pin.platform} origin=${origin} sha256=${pin.sha256.slice(0, 12)}… cache=${cacheDir}`)
	const run = spawnSync(runtimePath, ["run", join(import.meta.dir, "skill.ts")], { encoding: "utf8", stdio: "inherit" })
	process.exit(run.status ?? 1)
}
