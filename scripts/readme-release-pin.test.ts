import { expect, test } from "bun:test"

const readmeUrl = new URL("../README.md", import.meta.url)

test("production installation pins each marketplace checkout to a release tag", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const productionInstall = readme.slice(
		readme.indexOf("## Install in Claude Code"),
		readme.indexOf("## Upgrade and roll back"),
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

test("replacement guidance preserves the documented refresh operations", async () => {
	const readme = await Bun.file(readmeUrl).text()
	expect(readme).toContain("claude plugin marketplace update PLUGIN_NAME")
	expect(readme).toContain("codex plugin marketplace upgrade PLUGIN_NAME")
	expect(readme).toContain("Automatic Codex marketplace refresh is unspecified")
	expect(readme).toContain("A pinned immutable tag should resolve to the same bytes")
})

test("release preflight peels annotated tags and accepts only GitHub SSH status 1", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const preflight = readme.slice(
		readme.indexOf("## Preflight a release tag"),
		readme.indexOf("## Install in Claude Code"),
	)

	expect(preflight).toContain('fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"')
	expect(preflight).toContain('rev-parse "refs/tags/$TAG^{commit}"')
	expect(preflight).not.toContain("git ls-remote --refs \"$FETCH_URL\" \"refs/tags/$TAG\" | awk")
	expect(preflight).toContain("SSH_STATUS=$?")
	expect(preflight).toContain('if test "$SSH_STATUS" -ne 1; then')
	expect(preflight).toContain("exit 1")
})

test("release documentation names checksum evidence and exact repair identity", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const release = readme.slice(readme.indexOf("## Release"), readme.indexOf("## Proof commands"))

	expect(readme.toLowerCase()).not.toContain("provenance")
	expect(readme).toContain("*.checksums.json")
	expect(release).toContain("incomplete-publication repair")
	expect(release).toContain("`RELEASE_PLEASE_TOKEN`")
	expect(release).toContain("`RELEASE_PLEASE_AUTOMATION_LOGIN`")
	expect(release).toContain("Release automation requires `RELEASE_PLEASE_TOKEN`")
	expect(release).toContain("it does not fall back to `GITHUB_TOKEN`")
	expect(release).toContain("both the release-impact gate and publication admission bind that identity")
	expect(release).toContain("`maintenance` is the default")
	expect(release).toContain("it only updates the standing release PR and never publishes")
	expect(release).toContain("`repair` requires `release_tag`")
	expect(release).toContain("exact existing `vX.Y.Z` tag")
	expect(release).toContain("This repairs an incomplete publication; it does not create a new release.")
	expect(release.match(/-f operation=maintenance/g)).toHaveLength(1)
	expect(release.match(/-f operation=repair/g)).toHaveLength(2)
})

test("Codex support boundary names only the proven client surfaces", async () => {
	const readme = await Bun.file(readmeUrl).text()

	expect(readme).toContain(
		"Supported Codex surfaces: Codex CLI and Codex in the ChatGPT desktop app.",
	)
	expect(readme).toContain(
		"This repository does not claim support for the IDE extension, Chat, mobile, or a universal Codex host.",
	)
})
