/** Complete process result emitted by a harness adapter. */
export interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

function success(stdout = "", stderr = ""): CommandResult {
	return { exitCode: 0, stdout, stderr }
}

function failure(message: string): CommandResult {
	return {
		exitCode: 2,
		stdout: "",
		stderr: `hello-world: ${message}\nRun hello-world --help for usage.\n`,
	}
}

function optionValue(arguments_: string[], option: string): string | undefined {
	const index = arguments_.indexOf(option)
	if (index === -1) return undefined
	return arguments_[index + 1]
}

function help(): string {
	return `Usage:
  hello-world hello [--name <name>] [--json]
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
`
}

/**
 * Execute the portable command contract without depending on a host runtime.
 *
 * @param arguments_ - Command arguments after the executable name
 * @param runId - Adapter-owned invocation identity
 * @returns Complete process output and exit status for the adapter to emit
 *
 * @example
 * ```ts
 * executeCommand(["hello", "--json"], "proof-run")
 * ```
 */
export function executeCommand(
	arguments_: string[],
	runId: string,
): CommandResult {
	const [command, ...commandArguments] = arguments_

	if (command === undefined || command === "--help" || command === "-h") {
		return success(help())
	}
	if (command === "hello") {
		const name = optionValue(commandArguments, "--name") ?? "world"
		if (commandArguments.includes("--json")) {
			return success(
				`${JSON.stringify({
					ok: true,
					command: "hello",
					message: `Hello, ${name}!`,
					sideEffects: "none",
					runId,
				})}\n`,
			)
		}
		return success(`Hello, ${name}!\n`)
	}

	return failure(`unknown command: ${command}`)
}
