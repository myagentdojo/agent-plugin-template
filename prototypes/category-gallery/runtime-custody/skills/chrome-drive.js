// PROTOTYPE — an OS-integrated skill. Spawns a process (stands in for driving Chrome).
import { spawnSync } from "node:child_process"
const r = spawnSync("git", ["--version"], { encoding: "utf8" })
console.log(`chrome-drive: spawned -> ${(r.stdout||r.stderr).trim()} | args=${JSON.stringify(process.argv.slice(2))}`)
