import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workflowUrl = new URL(
	"../.github/workflows/codex-review-gate.yml",
	import.meta.url,
)

type WorkflowJob = {
	env: Record<string, string>
	steps: Array<{ name?: string; run?: string }>
}

async function runCleanReviewComment(commentBody: string): Promise<string> {
	const workflow = Bun.YAML.parse(await Bun.file(workflowUrl).text()) as {
		jobs: Record<string, WorkflowJob>
	}
	const job = workflow.jobs["complete-comment"]
	const script = job.steps.find((step) => step.name === "Mark the reviewed PR commit successful")?.run
	if (!script) throw new Error("complete-comment success script is missing")

	const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-review-gate-"))
	const callsPath = join(temporaryRoot, "gh-calls")
	try {
		const result = Bun.spawnSync({
			cmd: [
				"bash",
				"-c",
				`gh() {
	if [[ "$*" == *"pulls/13"* ]]; then
		printf '%s\\n' '38d88841ee82cf88b52b9d27f08dd29347869581'
	else
		printf '%s\\n' "$*" >> "$GH_CALLS"
	fi
}
export -f gh
${script}`,
			],
			env: {
				...process.env,
				COMMENT_BODY: commentBody,
				CLEAN_REVIEW_MARKER: job.env.CLEAN_REVIEW_MARKER ?? "",
				GH_CALLS: callsPath,
				GH_TOKEN: "test-token",
				GITHUB_REPOSITORY: "myagentdojo/agent-plugin-template",
				GITHUB_SERVER_URL: "https://github.com",
				PR_NUMBER: "13",
				REVIEW_MARKER: job.env.REVIEW_MARKER,
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

const aboutCodexDetails = `

<details> <summary>ℹ️ About Codex in GitHub</summary>
Informational boilerplate may mention reviews and suggestions.
</details>`

test("Codex review gate is opt-in and fail-closed after a request", async () => {
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
	expect(source).toContain("collaborators/${COMMENTER}/permission")
	expect(source).toContain("admin|maintain|write")
	expect(source).toContain("chatgpt-codex-connector[bot]")
	expect(source).toContain("github.event.comment.user.login == 'chatgpt-codex-connector[bot]'")
	expect(source).toContain("reviewed_prefix=")
	expect(source).toContain('"${HEAD_SHA}" != "${reviewed_prefix}"*')
	expect(source).not.toContain("github.event.review")
	expect(source).not.toContain("actions/checkout")
})

test("clean Codex comment releases the gate from its stable verdict sentence", async () => {
	const calls = await runCleanReviewComment(
		`Codex Review: Didn't find any major issues. You're on a roll.\n\n**Reviewed commit:** \`38d88841ee8\`${aboutCodexDetails}`,
	)

	expect(calls).toContain("--raw-field state=success")
})

test("Codex comment without a clean marker leaves the gate unchanged", async () => {
	const calls = await runCleanReviewComment(
		`Codex Review: Found a major issue.\n\n**Reviewed commit:** \`38d88841ee8\`${aboutCodexDetails}`,
	)

	expect(calls).toBe("")
})

test("Codex comment with findings after the clean marker leaves the gate unchanged", async () => {
	const calls = await runCleanReviewComment(
		`Codex Review: Didn't find any major issues. Findings follow.\n\n**Reviewed commit:** \`38d88841ee8\`${aboutCodexDetails}`,
	)

	expect(calls).toBe("")
})

test("Codex comment with a separate finding paragraph leaves the gate unchanged", async () => {
	const calls = await runCleanReviewComment(
		`Codex Review: Didn't find any major issues. Bravo.\n\nFinding: a major defect remains.\n\n**Reviewed commit:** \`38d88841ee8\`${aboutCodexDetails}`,
	)

	expect(calls).toBe("")
})
