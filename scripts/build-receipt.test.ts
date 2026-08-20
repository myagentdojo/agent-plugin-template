import { afterEach, expect, test } from "bun:test"
import {
	appendFileSync,
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
	buildReceiptPath,
	evaluateFreshness,
	readBuildReceipt,
	writeBuildReceipt,
} from "./build-receipt"

const repositoryRoot = join(import.meta.dir, "..")
const created: string[] = []
const restoreWritable: string[] = []

afterEach(() => {
	// A directory locked to prove the unwritable path would otherwise leave a
	// tree rmSync cannot descend into.
	for (const directory of restoreWritable.splice(0)) chmodSync(directory, 0o700)
	for (const directory of created.splice(0)) rmSync(directory, { force: true, recursive: true })
})

/**
 * Copy the real payload so freshness is proven against genuine plugin bytes.
 *
 * A hand-built fixture would let the digest agree with itself while the real
 * inventory walk rejected the tree, which is the failure this proof exists to
 * catch.
 */
function checkoutWithRealPayload(): string {
	const root = mkdtempSync(join(tmpdir(), "build-receipt-"))
	created.push(root)
	cpSync(join(repositoryRoot, "plugin"), join(root, "plugin"), { recursive: true })
	cpSync(join(repositoryRoot, "plugin.config.json"), join(root, "plugin.config.json"))
	return root
}

test("a failed build leaves a receipt recording the failure", () => {
	const root = checkoutWithRealPayload()

	writeBuildReceipt(root, "failed", "bundle must emit exactly one JavaScript artifact")

	const receipt = readBuildReceipt(root)
	expect(receipt?.outcome).toBe("failed")
	expect(receipt?.failureReason).toBe("bundle must emit exactly one JavaScript artifact")
})

test("check reports a failed build rather than reporting the payload as ready", () => {
	const root = checkoutWithRealPayload()
	writeBuildReceipt(root, "failed", "bundler-failure")

	const freshness = evaluateFreshness(root)

	expect(freshness.status).toBe("build-failed")
	expect(freshness.status).not.toBe("fresh")
	expect(freshness.reason).toContain("bundler-failure")
})

test("a payload edited after its build is reported as stale", () => {
	const root = checkoutWithRealPayload()
	writeBuildReceipt(root, "succeeded")
	expect(evaluateFreshness(root).status).toBe("fresh")

	appendFileSync(join(root, "plugin", "THIRD-PARTY-NOTICES.md"), "\ndrift\n")

	const freshness = evaluateFreshness(root)
	expect(freshness.status).toBe("stale")
	expect(freshness.reason).toContain("changed after the build")
})

test("a missing receipt reports freshness as unproven rather than fresh", () => {
	const root = checkoutWithRealPayload()

	const freshness = evaluateFreshness(root)

	expect(freshness.status).toBe("unproven")
	expect(freshness.receipt).toBeUndefined()
})

test("a malformed receipt reports unproven rather than throwing", () => {
	const root = checkoutWithRealPayload()
	writeBuildReceipt(root, "succeeded")
	writeFileSync(buildReceiptPath(root), "{ not json")

	expect(() => evaluateFreshness(root)).not.toThrow()
	expect(evaluateFreshness(root).status).toBe("unproven")
})

test("a receipt missing its contract identity is treated as absent", () => {
	const root = checkoutWithRealPayload()
	writeBuildReceipt(root, "succeeded")
	writeFileSync(buildReceiptPath(root), JSON.stringify({ outcome: "succeeded" }))

	expect(readBuildReceipt(root)).toBeUndefined()
	expect(evaluateFreshness(root).status).toBe("unproven")
})

/**
 * The receipt is evidence that can lie. A receipt claiming success while
 * naming a payload that no longer exists on disk must never be believed on its
 * own word, because it looks exactly like proof.
 */
test("a successful receipt whose digest disagrees never reports fresh", () => {
	const root = checkoutWithRealPayload()
	writeBuildReceipt(root, "succeeded")
	const receipt = JSON.parse(readFileSync(buildReceiptPath(root), "utf8"))
	receipt.payloadDigest = "0".repeat(64)
	writeFileSync(buildReceiptPath(root), JSON.stringify(receipt))

	expect(evaluateFreshness(root).status).toBe("stale")
})

/**
 * Assert against a receipt this test wrote, never the ambient one left by a
 * local build. Reading the repository's own receipt passes on a machine that
 * has built and fails in CI, where `.dev/` is gitignored and absent.
 */
test("the receipt records the checkout, version, and commit that built the payload", () => {
	const root = checkoutWithRealPayload()

	writeBuildReceipt(root, "succeeded")

	const receipt = readBuildReceipt(root)
	expect(receipt?.checkoutPath).toBe(resolve(root))
	expect(receipt?.pluginVersion).toMatch(/^\d+\.\d+\.\d+$/)
	expect(receipt?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

/**
 * A payload copied outside git still produces a usable receipt: the git fields
 * are omitted rather than faked, and the digest that proves freshness is present.
 */
test("git identity is omitted outside a repository, and the digest still records", () => {
	const outsideGit = checkoutWithRealPayload()

	const receipt = writeBuildReceipt(outsideGit, "succeeded")

	expect(receipt?.headCommit).toBeUndefined()
	expect(receipt?.branch).toBeUndefined()
	expect(receipt?.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
})

/**
 * Acceptance 4. `plugin/` is tracked, so a receipt written inside it would
 * dirty every working tree. The receipt path must stay ignored by git.
 */
test("the receipt path is ignored by git", () => {
	const result = Bun.spawnSync({
		cmd: ["git", "check-ignore", buildReceiptPath(repositoryRoot)],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(0)
})

/**
 * Acceptance 3 and 4 in one shape: the receipt must never become a payload
 * entry, because the release archive is compared byte for byte across two
 * builds and a timestamp inside it would fail determinism by construction.
 */
test("the receipt lives outside the plugin payload", () => {
	expect(buildReceiptPath(repositoryRoot).startsWith(join(repositoryRoot, "plugin"))).toBe(false)
})

test("writing a receipt never throws, even into an unwritable location", () => {
	const checkout = mkdtempSync(join(tmpdir(), "receipt-readonly-"))
	created.push(checkout)
	// A checkout with a valid configuration reaches the write itself. Pointing
	// at a missing directory returned at the configuration read instead, so the
	// write path this names went unexercised.
	writeFileSync(
		join(checkout, "plugin.config.json"),
		readFileSync(join(repositoryRoot, "plugin.config.json"), "utf8"),
	)
	const development = join(checkout, ".dev")
	mkdirSync(development, { recursive: true })
	chmodSync(development, 0o500)
	restoreWritable.push(development)

	expect(() => writeBuildReceipt(checkout, "succeeded")).not.toThrow()
	expect(writeBuildReceipt(checkout, "succeeded")).toBeUndefined()
})

/**
 * An invalid plugin.config.json is a build failure, and it is the failure most
 * likely to break a build. Reading the version inside the write guard returned
 * before the receipt was written, so `check` reported `unproven` rather than
 * `build-failed` for exactly that case.
 */
test("a failure is recorded even when the plugin configuration cannot be read", () => {
	const checkout = mkdtempSync(join(tmpdir(), "receipt-badconfig-"))
	created.push(checkout)
	writeFileSync(join(checkout, "plugin.config.json"), "{ not json")

	const receipt = writeBuildReceipt(checkout, "failed", "bundler-failure")

	expect(receipt?.outcome).toBe("failed")
	expect(receipt?.pluginVersion).toBe("unknown")
	expect(readBuildReceipt(checkout)?.outcome).toBe("failed")
})

test("a receipt from an unsupported schema version is rejected", () => {
	const checkout = mkdtempSync(join(tmpdir(), "receipt-schema-"))
	created.push(checkout)
	writeFileSync(
		join(checkout, "plugin.config.json"),
		readFileSync(join(repositoryRoot, "plugin.config.json"), "utf8"),
	)
	const written = writeBuildReceipt(checkout, "succeeded")
	expect(written).toBeDefined()
	const path = buildReceiptPath(checkout)
	// A digest that still matches is the point: only the schema disqualifies it.
	writeFileSync(
		path,
		JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), schemaVersion: 2 }),
	)

	expect(readBuildReceipt(checkout)).toBeUndefined()
})

/**
 * Do not restore `generate:check` as a separate `&&` stage in the build script.
 * As its own stage it failed before `build.ts` ran, so no receipt was written
 * and the previous build's `succeeded` receipt survived to be read as proof
 * that the payload was current. That is the invisibility this receipt exists to
 * end, and it was reproduced rather than reasoned about.
 */
test("the build command records a failure that happens before bundling", () => {
	const script = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts
		.build

	expect(script).toBe("bun run scripts/build.ts")
	expect(script).not.toContain("&&")
})
