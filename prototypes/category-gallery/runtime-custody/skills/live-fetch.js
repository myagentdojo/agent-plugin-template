// PROTOTYPE — an OS-integrated skill. Touches network + fs (stands in for a live API fetch + cache).
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const dir = mkdtempSync(join(tmpdir(), "live-fetch-"))
const f = join(dir, "cache.json"); writeFileSync(f, JSON.stringify({ ok: true, at: "prototype" }))
console.log(`live-fetch: wrote+read cache -> ${readFileSync(f,"utf8")} | args=${JSON.stringify(process.argv.slice(2))}`)
