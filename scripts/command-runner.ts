import { constants as osConstants } from "node:os"

/** Options that preserve the subprocess semantics a caller intentionally selects. */
export interface CommandRunOptions {
	/** Working directory for the child process. */
	workingDirectory?: string
	/** Complete environment visible to the child process. */
	environment?: Record<string, string | undefined>
	/** Text written to stdin; omission closes stdin without input. */
	input?: string
	/** Maximum child lifetime in milliseconds. */
	timeout?: number
	/** Preserve leading and trailing output when false. @defaultValue true */
	trimOutput?: boolean
}

/** Stable command result independent of Bun's process handle types. */
export interface CommandOutput {
	/** Stable numeric process status; timeouts use 124. */
	exitCode: number
	/** Captured standard output. */
	stdout: string
	/** Captured standard error. */
	stderr: string
}

/**
 * Substitute command execution without changing the workflow that issues commands.
 *
 * @example
 * ```typescript
 * const result = runner.run(["git", "status"], { workingDirectory: repositoryRoot })
 * ```
 */
export interface CommandRunner {
	/** Run one complete argument vector and return captured process evidence. */
	run(command: readonly string[], options?: CommandRunOptions): CommandOutput
}

/**
 * Execute commands synchronously through Bun for production script workflows.
 *
 * @example
 * ```typescript
 * const result = bunCommandRunner.run(["git", "rev-parse", "HEAD"], {
 *   workingDirectory: repositoryRoot,
 * })
 * ```
 */
export const bunCommandRunner: CommandRunner = {
	run(command, options = {}) {
		const result = Bun.spawnSync({
			cmd: [...command],
			cwd: options.workingDirectory,
			env: options.environment,
			stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
			stdout: "pipe",
			stderr: "pipe",
			timeout: options.timeout,
		})
		const stdout = result.stdout.toString()
		const stderr = result.stderr.toString()
		const trimOutput = options.trimOutput ?? true
		const signalNumber = result.signalCode
			? osConstants.signals[result.signalCode as keyof typeof osConstants.signals]
			: undefined
		return {
			exitCode:
				result.exitCode ??
				(result.exitedDueToTimeout ? 124 : signalNumber === undefined ? 1 : 128 + signalNumber),
			stdout: trimOutput ? stdout.trim() : stdout,
			stderr: trimOutput ? stderr.trim() : stderr,
		}
	},
}
