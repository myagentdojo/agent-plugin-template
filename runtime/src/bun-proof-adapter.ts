import config from "../../plugin.config.json"

Object.assign(globalThis, { PLUGIN_VERSION: config.version })

const { executeCommand } = await import("./portable-command")

const standardInput = await Bun.stdin.text()
const result = executeCommand(
	process.argv.slice(2),
	standardInput,
	process.env.HELLO_WORLD_RUN_ID ?? crypto.randomUUID(),
)

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exit(result.exitCode)
