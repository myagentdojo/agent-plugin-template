/**
 * Harness-owned paths and presentation vocabulary.
 *
 * @example
 * ```typescript
 * const identity: HarnessIdentity = HARNESS_IDENTITIES.claude
 * ```
 */
export interface HarnessIdentity {
	/** Plugin-relative hook declaration referenced by the native manifest. */
	hooksDeclarationPath: string
	/** Plugin-relative directory containing the native manifest. */
	manifestDirectory: string
	/** Host-provided environment variable containing the installed plugin root. */
	pluginRootEnvVar: string
	/** Human-readable harness name used in diagnostics. */
	displayName: string
}

/**
 * Canonical harness identities and their native integration values.
 *
 * @example
 * ```typescript
 * const hooksPath = HARNESS_IDENTITIES.claude.hooksDeclarationPath
 * ```
 */
export const HARNESS_IDENTITIES = {
	claude: {
		hooksDeclarationPath: "./hooks/claude/hooks.json",
		manifestDirectory: ".claude-plugin",
		pluginRootEnvVar: "CLAUDE_PLUGIN_ROOT",
		displayName: "Claude",
	},
	codex: {
		hooksDeclarationPath: "./hooks/codex/hooks.json",
		manifestDirectory: ".codex-plugin",
		pluginRootEnvVar: "PLUGIN_ROOT",
		displayName: "Codex",
	},
} as const satisfies Record<string, HarnessIdentity>

/**
 * Canonical lowercase harness discriminator.
 *
 * @example
 * ```typescript
 * const harness: HarnessId = "codex"
 * ```
 */
export type HarnessId = keyof typeof HARNESS_IDENTITIES

/**
 * Qualification clients mapped to the harness whose payload they exercise.
 *
 * `codex-desktop` is vocabulary only; this registry does not create a desktop code path.
 *
 * @example
 * ```typescript
 * const harness = QUALIFICATION_CLIENT_HARNESSES["codex-desktop"]
 * ```
 */
export const QUALIFICATION_CLIENT_HARNESSES = {
	"claude-cli": "claude",
	"codex-cli": "codex",
	"codex-desktop": "codex",
} as const satisfies Record<string, HarnessId>

/**
 * Client vocabulary used by native qualification receipts and journeys.
 *
 * @example
 * ```typescript
 * const client: QualificationClient = "claude-cli"
 * ```
 */
export type QualificationClient = keyof typeof QUALIFICATION_CLIENT_HARNESSES
