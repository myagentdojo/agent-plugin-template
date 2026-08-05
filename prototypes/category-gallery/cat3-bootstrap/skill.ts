// PROTOTYPE — throwaway. Category 3: OS-integrated skill. Spawns a real
// subprocess and touches the filesystem — impossible under QuickJS, needs a
// real Bun/Node runtime. Run via the bootstrap launcher (launcher.ts).
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 1) filesystem: write + read a scratch file.
const dir = mkdtempSync(join(tmpdir(), "cat3-"))
const file = join(dir, "note.txt")
writeFileSync(file, "os-integrated payload\n")
const readback = readFileSync(file, "utf8").trim()

// 2) process spawn: shell out to a real subprocess.
const proc = spawnSync("git", ["--version"], { encoding: "utf8" })
const gitLine = (proc.stdout || proc.stderr || "").trim()

rmSync(dir, { recursive: true, force: true })
console.log(`cat3 (OS-integrated on Bun): fs readback="${readback}" | spawned git -> "${gitLine}"`)
