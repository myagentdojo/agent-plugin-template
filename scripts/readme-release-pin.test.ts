import { expect, test } from "bun:test"

const readmeUrl = new URL("../README.md", import.meta.url)

test("production installation pins each marketplace checkout to a release tag", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const productionInstall = readme.slice(
		readme.indexOf("## Install in Claude Code"),
		readme.indexOf("## Develop locally"),
	)
	const marketplaceAdds = productionInstall
		.split("\n")
		.filter((line) => /^(claude|codex) plugin marketplace add /.test(line))

	expect(marketplaceAdds).toEqual([
		"claude plugin marketplace add OWNER/REPOSITORY@vX.Y.Z",
		"claude plugin marketplace add git@github.com:OWNER/REPOSITORY.git#vX.Y.Z",
		"codex plugin marketplace add OWNER/REPOSITORY --ref vX.Y.Z",
		"codex plugin marketplace add git@github.com:OWNER/REPOSITORY.git --ref vX.Y.Z",
	])
	expect(productionInstall).not.toMatch(/codex plugin marketplace add .*--ref main/)
	expect(productionInstall).not.toContain("plugin marketplace update")
	expect(productionInstall).not.toContain("plugin marketplace upgrade")
	expect(productionInstall.match(/Remove the pinned marketplace entry/g)).toHaveLength(2)
})
