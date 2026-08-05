import { expect, test } from "bun:test"

const workflowUrl = new URL(
	"../.github/workflows/codex-review-gate.yml",
	import.meta.url,
)

test("Codex review gate is opt-in and fail-closed after a request", async () => {
	const source = await Bun.file(workflowUrl).text()
	const workflow = Bun.YAML.parse(source)

	expect(workflow).toMatchObject({
		on: {
			pull_request_target: {
				types: ["opened", "reopened", "synchronize"],
			},
			issue_comment: { types: ["created"] },
			pull_request_review: { types: ["submitted"] },
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
	expect(source).toContain('"${REVIEW_SHA}" != "${HEAD_SHA}"')
	expect(source).not.toContain("actions/checkout")
})
