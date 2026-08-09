import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workflowUrl = new URL(
	"../.github/workflows/codex-review-gate.yml",
	import.meta.url,
)

type WorkflowJob = {
	steps: Array<{ name?: string; run?: string }>
}

type ApprovalOptions = {
	approvedPrefix?: string
	findingSurface?: "review" | "inline" | "remapped-inline" | null
	permission?: string
	receiptAuthor?: string
	receiptBody?: string
}

const headSha = "38d88841ee82cf88b52b9d27f08dd29347869581"

async function runApproval(options: ApprovalOptions = {}): Promise<string> {
	const workflow = Bun.YAML.parse(await Bun.file(workflowUrl).text()) as {
		jobs: Record<string, WorkflowJob>
	}
	const job = workflow.jobs.approve
	const script = job.steps.find(
		(step) => step.name === "Mark the attested PR commit successful",
	)?.run
	if (!script) throw new Error("approve success script is missing")

	const approvedPrefix = options.approvedPrefix ?? headSha.slice(0, 10)
	const receipt = {
		user: { login: options.receiptAuthor ?? "chatgpt-codex-connector[bot]" },
		body:
			options.receiptBody ??
			`Codex Review: Didn't find any major issues. Breezy!\n\n**Reviewed commit:** \`${approvedPrefix}\``,
	}

	const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-review-gate-"))
	const callsPath = join(temporaryRoot, "gh-calls")
	try {
		const result = Bun.spawnSync({
			cmd: [
				"bash",
				"-c",
				`gh() {
	if [[ "$*" == *"collaborators/maintainer/permission"* ]]; then
		printf '%s\\n' "$CODEX_PERMISSION"
	elif [[ "$*" == *"issues/comments/4242"* ]]; then
		printf '%s\\n' "$CODEX_RECEIPT"
	elif [[ "$*" == *"pulls/13/reviews"* ]]; then
		if [[ "$CODEX_FINDING_SURFACE" == "review" ]]; then
			printf '%s\\n' '[{"user":{"login":"chatgpt-codex-connector[bot]"},"commit_id":"${headSha}"}]'
		else
			printf '%s\\n' '[]'
		fi
	elif [[ "$*" == *"pulls/13/comments"* ]]; then
		if [[ "$CODEX_FINDING_SURFACE" == "inline" ]]; then
			printf '%s\\n' '[{"user":{"login":"chatgpt-codex-connector[bot]"},"commit_id":"${headSha}","original_commit_id":"${headSha}"}]'
		elif [[ "$CODEX_FINDING_SURFACE" == "remapped-inline" ]]; then
			printf '%s\\n' '[{"user":{"login":"chatgpt-codex-connector[bot]"},"commit_id":"${headSha}","original_commit_id":"9907c53775f758758dc2a5f7670eee335efca05d"}]'
		else
			printf '%s\\n' '[]'
		fi
	elif [[ "$*" == *"pulls/13"* ]]; then
		printf '%s\\n' '${headSha}'
	else
		printf '%s\\n' "$*" >> "$GH_CALLS"
	fi
}
export -f gh
${script}`,
			],
			env: {
				...process.env,
				CODEX_FINDING_SURFACE: options.findingSurface ?? "",
				CODEX_PERMISSION: options.permission ?? "write",
				CODEX_RECEIPT: JSON.stringify(receipt),
				COMMENT_BODY: `@codex-gate approve ${approvedPrefix} 4242`,
				COMMENTER: "maintainer",
				GH_CALLS: callsPath,
				GH_TOKEN: "test-token",
				GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
				GITHUB_SERVER_URL: "https://github.com",
				PR_NUMBER: "13",
				STATUS_CONTEXT: "Codex review gate",
			},
			stdout: "pipe",
			stderr: "pipe",
		})
		expect(result.exitCode, result.stderr.toString()).toBe(0)
		return readFileSync(callsPath, { encoding: "utf8", flag: "a+" })
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
}

test("Codex review gate is opt-in and requires an authorized attestation", async () => {
	const source = await Bun.file(workflowUrl).text()
	const workflow = Bun.YAML.parse(source)

	expect(workflow).toMatchObject({
		on: {
			pull_request_target: {
				types: ["opened", "reopened", "synchronize"],
			},
			issue_comment: { types: ["created"] },
		},
		permissions: {
			contents: "read",
			"pull-requests": "read",
			statuses: "write",
		},
		env: { STATUS_CONTEXT: "Codex review gate" },
	})

	expect(source.match(/--raw-field state=success/g)).toHaveLength(2)
	expect(source.match(/--raw-field state=pending/g)).toHaveLength(1)
	expect(source.match(/collaborators\/\$\{COMMENTER\}\/permission/g)).toHaveLength(2)
	expect(source).toContain("@codex-gate")
	expect(source).toContain("admin|maintain|write")
	expect(source).toContain("chatgpt-codex-connector[bot]")
	expect(source).not.toContain("github.event.review")
	expect(source).not.toContain("actions/checkout")
})

test("authorized current-head attestation releases a clean Codex review", async () => {
	const calls = await runApproval()
	expect(calls).toContain("--raw-field state=success")
})

test("stale attestation leaves the gate unchanged", async () => {
	const calls = await runApproval({ approvedPrefix: "deadbeef00" })
	expect(calls).toBe("")
})

test("attestation with a receipt for another commit leaves the gate unchanged", async () => {
	const calls = await runApproval({
		receiptBody:
			"Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `deadbeef00`",
	})
	expect(calls).toBe("")
})

test("attestation with a non-Codex receipt leaves the gate unchanged", async () => {
	const calls = await runApproval({ receiptAuthor: "untrusted-bot" })
	expect(calls).toBe("")
})

test("attestation from a reader leaves the gate unchanged", async () => {
	const calls = await runApproval({ permission: "read" })
	expect(calls).toBe("")
})

test("Codex review finding object blocks an attestation", async () => {
	const calls = await runApproval({ findingSurface: "review" })
	expect(calls).toBe("")
})

test("Codex inline finding blocks an attestation", async () => {
	const calls = await runApproval({ findingSurface: "inline" })
	expect(calls).toBe("")
})

test("resolved inline finding remapped onto the current diff does not block attestation", async () => {
	const calls = await runApproval({ findingSurface: "remapped-inline" })
	expect(calls).toContain("--raw-field state=success")
})
