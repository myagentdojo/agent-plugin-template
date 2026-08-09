export interface ProofControlEnvelope {
	schemaVersion: number
	ok: boolean
	code: string
	sideEffects: string[]
	retrySafe?: boolean
	nextAction: string
	runtime?: { version?: string; executableSha256?: string }
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRuntimeIdentity(value: unknown): value is NonNullable<ProofControlEnvelope["runtime"]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const runtime = value as Record<string, unknown>
	return (
		(runtime.version === undefined || typeof runtime.version === "string") &&
		(runtime.executableSha256 === undefined || typeof runtime.executableSha256 === "string")
	)
}

function hasValidPayload(
	value: Record<string, unknown>,
): value is Record<string, unknown> & ProofControlEnvelope {
	return (
		typeof value.ok === "boolean" &&
		isStringArray(value.sideEffects) &&
		typeof value.nextAction === "string" &&
		(value.retrySafe === undefined || typeof value.retrySafe === "boolean") &&
		(value.runtime === undefined || isRuntimeIdentity(value.runtime))
	)
}

/** Read one runtime control envelope while preserving proof-specific step context. */
export function requireProofControlEnvelope(
	step: string,
	result: ReturnType<typeof Bun.spawnSync>,
	expectedExit: number,
	expectedCode: string,
): ProofControlEnvelope {
	if (result.exitCode !== expectedExit) {
		throw new Error(`${step}: exit ${result.exitCode}; ${result.stderr.toString().trim()}`)
	}
	const lines = result.stdout.toString().trim().split("\n")
	if (lines.length !== 1) throw new Error(`${step}: expected one JSON control object`)
	let parsed: unknown
	try {
		parsed = JSON.parse(lines[0])
	} catch {
		throw new Error(`${step}: expected one JSON control object`)
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${step}: expected one JSON control object`)
	}
	const envelope = parsed as Record<string, unknown>
	if (envelope.schemaVersion !== 1 || envelope.code !== expectedCode) {
		throw new Error(`${step}: expected ${expectedCode}, received ${String(envelope.code)}`)
	}
	if (!hasValidPayload(envelope)) {
		throw new Error(`${step}: invalid ${expectedCode} control object`)
	}
	return envelope
}
