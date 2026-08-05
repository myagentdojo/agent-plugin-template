import * as std from "qjs:std"

import { executeCommand } from "./portable-command"

declare const scriptArgs: string[]

const standardInput = std.in.readAsString()
const runId = std.getenv("HELLO_WORLD_RUN_ID") ?? `quickjs-${Date.now()}`
const result = executeCommand(scriptArgs.slice(1), standardInput, runId)

if (result.stdout) std.out.puts(result.stdout)
if (result.stderr) std.err.puts(result.stderr)
std.exit(result.exitCode)
