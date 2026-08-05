/** Complete process result emitted by a host adapter. */
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
	return `hello-world 0.1.0

Usage:
  hello-world hello [--name <name>] [--json]
  hello-world hook --harness <codex|claude> --event <event>
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
  hook   Accept a harness hook payload on stdin and exit successfully.
`
}

/**
 * Execute the portable command contract without depending on a host runtime.
 *
 * @param arguments_ - Command arguments after the executable name
 * @param standardInput - Complete hook payload supplied by the adapter
 * @param runId - Adapter-owned invocation identity
 * @returns Complete process output and exit status for the adapter to emit
 *
 * @example
 * ```ts
 * executeCommand(["hello", "--json"], "", "proof-run")
 * ```
 */
export function executeCommand(
	arguments_: string[],
	standardInput: string,
	runId: string,
): CommandResult {
	const [command, ...commandArguments] = arguments_

	if (command === undefined || command === "--help" || command === "-h") {
		return success(help())
	}
	if (command === "--version" || command === "-v") return success("0.1.0\n")

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

	if (command === "hook") {
		const harness = optionValue(commandArguments, "--harness")
		const event = optionValue(commandArguments, "--event")
		if (harness !== "codex" && harness !== "claude") {
			return failure("--harness must be codex or claude")
		}
		if (!event) return failure("--event is required")
		if (standardInput.trim()) {
			try {
				JSON.parse(standardInput)
			} catch {
				return failure("hook stdin must be JSON")
			}
		}
		return success("", `hello-world hook: ${harness} ${event}\n`)
	}

	return failure(`unknown command: ${command}`)
}
