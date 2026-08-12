import { expect, test } from "bun:test"

const readmeUrl = new URL("../README.md", import.meta.url)
const installingUrl = new URL("../docs/installing.md", import.meta.url)
const maintainerIndexUrl = new URL("../docs/releasing.md", import.meta.url)
const pullRequestsUrl = new URL("../docs/pull-requests-and-ci.md", import.meta.url)
const qualificationUrl = new URL("../docs/native-capability-qualification.md", import.meta.url)
const releaseSetupUrl = new URL("../docs/release-setup.md", import.meta.url)
const publishingUrl = new URL("../docs/publishing.md", import.meta.url)
const releaseRepairUrl = new URL("../docs/release-repair.md", import.meta.url)
const canaryUrl = new URL("../docs/canary-qualification.md", import.meta.url)

test("README routes each branch directly to its owner", async () => {
	const readme = await Bun.file(readmeUrl).text()

	for (const pointer of [
		"[Add plugin behavior](#add-plugin-behavior)",
		"[Install, upgrade, or roll back a release](docs/installing.md)",
		"[Pull requests and CI](docs/pull-requests-and-ci.md)",
		"[Configure release automation](docs/release-setup.md)",
		"[Qualify fresh native capabilities](docs/native-capability-qualification.md)",
		"[Publish a release](docs/publishing.md)",
		"[Maintain or repair release state](docs/release-repair.md)",
		"[Qualify public and private canaries](docs/canary-qualification.md)",
	]) {
		expect(readme).toContain(pointer)
	}
	expect(readme).not.toContain("Create or extend a plugin repository")
	expect(readme).not.toContain("## Install in Claude Code")
	expect(readme).not.toContain("## Upgrade and roll back")
	expect(readme).not.toContain("## Public and private canaries")
})

test("maintainer index preserves one pointer per operator branch", async () => {
	const index = await Bun.file(maintainerIndexUrl).text()

	for (const pointer of [
		"[Pull requests and CI](pull-requests-and-ci.md)",
		"[Configure release automation](release-setup.md)",
		"[Qualify fresh native capabilities](native-capability-qualification.md)",
		"[Publish a release](publishing.md)",
		"[Maintain or repair release state](release-repair.md)",
		"[Qualify public and private canaries](canary-qualification.md)",
	]) {
		expect(index).toContain(pointer)
	}
	expect(index).not.toContain("gh workflow run")
	expect(index).not.toContain("bun run ship:canary")
})

test("production installation pins each marketplace checkout to a release tag", async () => {
	const installing = await Bun.file(installingUrl).text()
	const productionInstall = installing.slice(
		installing.indexOf("## Install in Claude Code"),
		installing.indexOf("## Upgrade and roll back"),
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
	const installing = await Bun.file(installingUrl).text()
	expect(installing).toContain("claude plugin marketplace update PLUGIN_NAME")
	expect(installing).toContain("codex plugin marketplace upgrade PLUGIN_NAME")
	expect(installing).toContain("Automatic Codex marketplace refresh is unspecified")
	expect(installing).toContain("A pinned immutable tag should resolve to the same bytes")
	expect(installing).toContain("`CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1`")
	expect(installing).toContain(
		"With it, a failed marketplace pull retains the last-known-good clone.",
	)
	expect(installing).toContain(
		"Without it, Claude Code deletes and re-clones the marketplace after a failed pull",
	)
})

test("release preflight peels annotated tags and accepts only GitHub SSH status 1", async () => {
	const installing = await Bun.file(installingUrl).text()
	const preflight = installing.slice(
		installing.indexOf("## Preflight a release tag"),
		installing.indexOf("## Install in Claude Code"),
	)

	expect(preflight).toContain('fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"')
	expect(preflight).toContain('rev-parse "refs/tags/$TAG^{commit}"')
	expect(preflight).not.toContain("git ls-remote --refs \"$FETCH_URL\" \"refs/tags/$TAG\" | awk")
	expect(preflight).toContain("SSH_STATUS=$?")
	expect(preflight).toContain('if test "$SSH_STATUS" -ne 1; then')
	expect(preflight).toContain("exit 1")
	expect(preflight).toContain("https://api.github.com/meta")
	expect(preflight).toContain('select(startswith("ssh-ed25519 "))')
	expect(preflight).toContain("StrictHostKeyChecking=yes")
	expect(preflight).toContain('UserKnownHostsFile="$GITHUB_KNOWN_HOSTS"')
	expect(preflight).toContain("export GIT_SSH_COMMAND")
	expect(preflight).toContain('ssh-keygen -F github.com -f "$GITHUB_KNOWN_HOSTS"')
	expect(preflight).toContain("ssh-add -l")
	expect(preflight.indexOf("https://api.github.com/meta")).toBeLessThan(
		preflight.indexOf("SSH_GREETING="),
	)
})

test("pull-request policy remains in its declared owner", async () => {
	const readme = await Bun.file(readmeUrl).text()
	const pullRequests = await Bun.file(pullRequestsUrl).text()

	expect(readme).not.toContain("feat: add a portable command")
	expect(pullRequests).toContain("feat: add a portable command")
	expect(pullRequests).toContain("Installable payload changes require a releasable title")
	expect(pullRequests).toContain("PR qualification completes when")
})

test("release setup binds the narrow automation identities", async () => {
	const setup = await Bun.file(releaseSetupUrl).text()

	expect(setup.toLowerCase()).not.toContain("provenance")
	expect(setup).toContain("`RELEASE_PLEASE_TOKEN`")
	expect(setup).toContain("`RELEASE_PLEASE_AUTOMATION_LOGIN`")
	expect(setup).toContain("Release automation requires `RELEASE_PLEASE_TOKEN`")
	expect(setup).toContain("it does not fall back to `GITHUB_TOKEN`")
	expect(setup).toContain("both the release-impact gate and publication admission bind that identity")
	expect(setup).toContain(
		"proves repository configuration and required environment, variable, and secret names",
	)
	expect(setup).toContain("never reads secret values or proves real credential access")
	expect(setup).toContain("token-backed GitHub API identity and SSH Git identity")
	expect(setup).toContain("rotate the stored token before expiry or revocation")
	expect(setup).not.toContain("GitHub App token")
	expect(setup).not.toContain("HTTPS Git identity")
})

test("publication remains bound to checksum evidence and the admitted candidate", async () => {
	const publishing = await Bun.file(publishingUrl).text()

	expect(publishing.toLowerCase()).not.toContain("provenance")
	expect(publishing).toContain("*.checksums.json")
	expect(publishing).toContain("incomplete-publication repair")
	expect(publishing).toContain("Publication completes when")
	expect(publishing).toContain("immutable tag targets the admitted candidate")
})

test("release repair preserves exact operations and a complete terminal bound", async () => {
	const repair = await Bun.file(releaseRepairUrl).text()

	expect(repair).toContain("`maintenance` is the default")
	expect(repair).toContain("it only updates the standing release PR and never publishes")
	expect(repair).toContain("`repair` requires `release_tag`")
	expect(repair).toContain("exact existing `vX.Y.Z` tag")
	expect(repair).toContain("This repairs an incomplete publication; it does not create a new release.")
	expect(repair.match(/-f operation=maintenance/g)).toHaveLength(1)
	expect(repair.match(/-f operation=repair/g)).toHaveLength(2)
	expect(repair).toContain("Repair completes when the immutable tag still targets the admitted candidate")
	expect(repair).toContain("the GitHub Release targets that commit")
	expect(repair).toContain("the archive and `*.checksums.json` match")
	expect(repair).toContain("the required public attestation exists")
})

test("native qualification and canary branch owners stay reachable", async () => {
	const qualification = await Bun.file(qualificationUrl).text()
	const canary = await Bun.file(canaryUrl).text()

	expect(qualification).toContain("# Qualify fresh native capabilities")
	expect(qualification).toContain("Qualification completes when")
	expect(canary).toContain("# Qualify public and private canaries")
	expect(canary).toContain("Canary qualification completes when")
})

test("Codex support boundary names only the proven client surfaces", async () => {
	const installing = await Bun.file(installingUrl).text()

	expect(installing).toContain(
		"Supported Codex surfaces: Codex CLI and Codex in the ChatGPT desktop app.",
	)
	expect(installing).toContain(
		"This repository does not claim support for the IDE extension, Chat, mobile, or a universal Codex host.",
	)
})
