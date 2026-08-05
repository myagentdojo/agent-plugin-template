import { expect, test } from "bun:test"

const readmeUrl = new URL("../README.md", import.meta.url)

test("production installation supports Claude updates and pins Codex releases", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const productionInstall = readme.slice(
		readme.indexOf("## Install in Claude Code"),
		readme.indexOf("## Develop locally"),
	)
	const marketplaceAdds = productionInstall
		.split("\n")
		.filter((line) => /^(claude|codex) plugin marketplace add /.test(line))

	expect(marketplaceAdds).toEqual([
		"claude plugin marketplace add OWNER/REPOSITORY",
		"claude plugin marketplace add git@github.com:OWNER/REPOSITORY.git",
		"codex plugin marketplace add OWNER/REPOSITORY --ref vX.Y.Z",
		"codex plugin marketplace add git@github.com:OWNER/REPOSITORY.git --ref vX.Y.Z",
	])
	expect(productionInstall).not.toMatch(/codex plugin marketplace add .*--ref main/)
	expect(productionInstall).toContain("claude plugin marketplace update PLUGIN_NAME")
	expect(productionInstall).toContain("claude plugin update PLUGIN_NAME@PLUGIN_NAME")
	expect(productionInstall.match(/Remove the pinned marketplace entry/g)).toHaveLength(1)
})
