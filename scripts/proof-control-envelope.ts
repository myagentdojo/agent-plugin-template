export interface ProofControlEnvelope {
	schemaVersion: number
	ok: boolean
	code: string
	sideEffects: string[]
	retrySafe?: boolean
	nextAction: string
	runtime?: { version?: string; executableSha256?: string }
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
	const envelope = JSON.parse(lines[0]) as ProofControlEnvelope
	if (envelope.schemaVersion !== 1 || envelope.code !== expectedCode) {
		throw new Error(`${step}: expected ${expectedCode}, received ${envelope.code}`)
	}
	return envelope
}
