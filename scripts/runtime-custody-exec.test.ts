import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "bun:test"

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const engineSourcePath = join(root, "plugin", "runtime", "runtime-exec")
const FIXTURE_BUN_VERSION = "9.9.9"

const temporaryRoots: string[] = []

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

function temporaryDirectory(prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
	temporaryRoots.push(directory)
	return directory
}

function sha256Hex(contents: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(contents).digest("hex")
}

// --- minimal stored (uncompressed) zip writer -------------------------------
// Lets fixtures create archives deterministically, including hostile shapes
// (duplicate members) that stock zip tools refuse to produce.

const crcTable = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(data: Uint8Array): number {
	let c = 0xffffffff
	for (let i = 0; i < data.length; i++) c = (crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
	return (c ^ 0xffffffff) >>> 0
}

function storedZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
	const encoder = new TextEncoder()
	const chunks: Uint8Array[] = []
	const central: Uint8Array[] = []
	let offset = 0
	for (const entry of entries) {
		const name = encoder.encode(entry.name)
		const crc = crc32(entry.data)
		const local = new DataView(new ArrayBuffer(30))
		local.setUint32(0, 0x04034b50, true)
		local.setUint16(4, 20, true)
		local.setUint16(10, 0, true)
		local.setUint16(12, 0x21, true)
		local.setUint32(14, crc, true)
		local.setUint32(18, entry.data.length, true)
		local.setUint32(22, entry.data.length, true)
		local.setUint16(26, name.length, true)
		chunks.push(new Uint8Array(local.buffer), name, entry.data)
		const header = new DataView(new ArrayBuffer(46))
		header.setUint32(0, 0x02014b50, true)
		header.setUint16(4, 20, true)
		header.setUint16(6, 20, true)
		header.setUint16(14, 0x21, true)
		header.setUint32(16, crc, true)
		header.setUint32(20, entry.data.length, true)
		header.setUint32(24, entry.data.length, true)
		header.setUint16(28, name.length, true)
		header.setUint32(42, offset, true)
		central.push(new Uint8Array(header.buffer), name)
		offset += 30 + name.length + entry.data.length
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0)
	const end = new DataView(new ArrayBuffer(22))
	end.setUint32(0, 0x06054b50, true)
	end.setUint16(8, entries.length, true)
	end.setUint16(10, entries.length, true)
	end.setUint32(12, centralSize, true)
	end.setUint32(16, offset, true)
	const parts = [...chunks, ...central, new Uint8Array(end.buffer)]
	const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let cursor = 0
	for (const part of parts) {
		total.set(part, cursor)
		cursor += part.length
	}
	return total
}

// --- fixture plugin tree ----------------------------------------------------

interface FixtureLock {
	version: string
	url: string
	archiveName: string
	archiveBytes: number
	archiveSha256: string
	executablePath: string
	executableBytes: number
	executableSha256: string
}

interface Fixture {
	root: string
	pluginRoot: string
	runtimeDir: string
	engine: string
	cacheDir: string
	storeRoot: string
	blobDir: string
	blobPath: string
	zipPath: string
	lock: FixtureLock
	bundles: Record<string, { path: string; bytes: number; sha256: string }>
	env: Record<string, string>
}

interface FixtureOptions {
	bunVersion?: string
	lockVersion?: string
	member?: string
	zipEntries?: Array<{ name: string; data: Uint8Array }>
	lock?: Partial<FixtureLock>
	url?: string
	hostToolDirs?: string
	extraCatalogSkills?: string[]
	allowFileUrlsForTests?: boolean
}

function fixtureBunScript(version: string): string {
	return `#!/bin/sh
flags=''
while [ $# -gt 0 ]; do
	case "$1" in
		--version)
			[ -z "\${BUN_OPTIONS-}" ] || exit 97
			case "$flags" in *--config=/dev/null*) ;; *) [ ! -f ./bunfig.toml ] || exit 98 ;; esac
			printf '%s\\n' '${version}'
			exit 0
			;;
		--*) flags="$flags $1"; shift ;;
		*) break ;;
	esac
done
if [ $# -lt 1 ]; then echo 'fixture bun: missing script' >&2; exit 64; fi
case "$flags" in
*--config=/dev/null*) ;;
*)
	if [ -f "\${HOME-}/.bunfig.toml" ] ||
		{ [ -n "\${XDG_CONFIG_HOME-}" ] && [ -f "$XDG_CONFIG_HOME/.bunfig.toml" ]; } ||
		[ -f ./bunfig.toml ]; then
		echo 'HOSTILE_BUNFIG_RAN' >&2
		exit 98
	fi
	;;
esac
script=$1
shift
FIXTURE_BUN_FLAGS=$flags
export FIXTURE_BUN_FLAGS
exec /bin/sh "$script" "$@"
`
}

function fixtureBundleScript(skillId: string): string {
	return `#!/bin/sh
if [ "\${1-}" = "exit7" ]; then
	printf 'bundle-out\\n'
	printf 'bundle-err\\n' >&2
	exit 7
fi
printf 'skill=${skillId}\\n'
printf 'args=%s\\n' "$*"
printf 'umask=%s\\n' "$(umask)"
printf 'cwd=%s\\n' "$PWD"
printf 'BUN_OPTIONS=%s\\n' "\${BUN_OPTIONS-unset}"
printf 'NODE_OPTIONS=%s\\n' "\${NODE_OPTIONS-unset}"
printf 'DO_NOT_TRACK=%s\\n' "\${DO_NOT_TRACK-unset}"
printf 'PATH=%s\\n' "\${PATH-unset}"
printf 'bunflags=%s\\n' "\${FIXTURE_BUN_FLAGS-unset}"
`
}

function renderFixtureLock(lock: FixtureLock): string {
	const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
	const cases = platforms
		.map(
			(platform) => `	${platform})
		RUNTIME_ASSET_ARCHIVE_NAME='${lock.archiveName}'
		RUNTIME_ASSET_URL='${lock.url}'
		RUNTIME_ASSET_ARCHIVE_BYTES='${lock.archiveBytes}'
		RUNTIME_ASSET_ARCHIVE_SHA256='${lock.archiveSha256}'
		RUNTIME_ASSET_EXECUTABLE_PATH='${lock.executablePath}'
		RUNTIME_ASSET_EXECUTABLE_BYTES='${lock.executableBytes}'
		RUNTIME_ASSET_EXECUTABLE_SHA256='${lock.executableSha256}'
		;;`,
		)
		.join("\n")
	return `#!/bin/sh
RUNTIME_LOCK_PROFILE='bun'
RUNTIME_LOCK_VERSION='${lock.version}'

runtime_lock_select_asset() {
	case "$1" in
${cases}
	*) return 1 ;;
	esac
}
`
}

function renderFixtureCatalog(skillIds: string[]): string {
	const cases = skillIds
		.map(
			(skillId) => `	${skillId})
		RUNTIME_SKILL_ENTRY='runtime/${skillId}.js'
		RUNTIME_SKILL_PROFILE='bun'
		;;`,
		)
		.join("\n")
	return `#!/bin/sh
runtime_catalog_select_skill() {
	case "$1" in
${cases}
	*) return 1 ;;
	esac
}
`
}

function renderFixtureInventory(
	bundles: Record<string, { path: string; bytes: number; sha256: string }>,
): string {
	const cases = Object.keys(bundles)
		.sort()
		.map(
			(skillId) => `	${skillId})
		RUNTIME_BUNDLE_PATH='${bundles[skillId].path}'
		RUNTIME_BUNDLE_BYTES='${bundles[skillId].bytes}'
		RUNTIME_BUNDLE_SHA256='${bundles[skillId].sha256}'
		;;`,
		)
		.join("\n")
	return `#!/bin/sh
runtime_inventory_select_bundle() {
	case "$1" in
${cases}
	*) return 1 ;;
	esac
}
`
}

function writeFixtureLock(fixture: Fixture, lock: FixtureLock): void {
	writeFileSync(join(fixture.runtimeDir, "runtime-lock.sh"), renderFixtureLock(lock))
}

function makeFixture(options: FixtureOptions = {}): Fixture {
	const fixtureRoot = temporaryDirectory("runtime-exec-fixture-")
	const pluginRoot = join(fixtureRoot, "plugin")
	const runtimeDir = join(pluginRoot, "runtime")
	mkdirSync(runtimeDir, { recursive: true })

	const bunVersion = options.bunVersion ?? FIXTURE_BUN_VERSION
	const member = options.member ?? "bun-fixture/bun"
	const bunBytes = new TextEncoder().encode(fixtureBunScript(bunVersion))
	const entries = options.zipEntries ?? [{ name: member, data: bunBytes }]
	const zipBytes = storedZip(entries)
	const assetDir = join(fixtureRoot, "assets")
	mkdirSync(assetDir)
	const zipPath = join(assetDir, "bun-fixture.zip")
	writeFileSync(zipPath, zipBytes)

	const lock: FixtureLock = {
		version: options.lockVersion ?? bunVersion,
		url: options.url ?? `file://${zipPath}`,
		archiveName: "bun-fixture.zip",
		archiveBytes: zipBytes.length,
		archiveSha256: sha256Hex(zipBytes),
		executablePath: member,
		executableBytes: bunBytes.length,
		executableSha256: sha256Hex(bunBytes),
		...options.lock,
	}
	writeFileSync(join(runtimeDir, "runtime-lock.sh"), renderFixtureLock(lock))

	const bundles: Fixture["bundles"] = {}
	for (const skillId of ["skill-a", "skill-b"]) {
		const text = fixtureBundleScript(skillId)
		const digest = sha256Hex(text)
		const fileName = `${skillId}-${digest.slice(0, 16)}.js`
		writeFileSync(join(runtimeDir, fileName), text)
		bundles[skillId] = {
			path: `runtime/${fileName}`,
			bytes: Buffer.byteLength(text),
			sha256: digest,
		}
	}
	const catalogSkills = ["skill-a", "skill-b", ...(options.extraCatalogSkills ?? [])]
	writeFileSync(join(runtimeDir, "skill-catalog.sh"), renderFixtureCatalog(catalogSkills))
	writeFileSync(join(runtimeDir, "bundle-inventory.sh"), renderFixtureInventory(bundles))

	let engineText = readFileSync(engineSourcePath, "utf8")
	if (options.allowFileUrlsForTests !== false) {
		engineText = engineText.replace(/^test_allow_file_urls=0$/m, "test_allow_file_urls=1")
	}
	if (options.hostToolDirs) {
		engineText = engineText.replace(
			/^host_tool_dirs='[^']*'$/m,
			`host_tool_dirs='${options.hostToolDirs}'`,
		)
	}
	const engine = join(runtimeDir, "runtime-exec")
	writeFileSync(engine, engineText)
	chmodSync(engine, 0o755)

	const cacheDir = join(fixtureRoot, "cache")
	mkdirSync(cacheDir)
	const storeRoot = join(cacheDir, "agent-plugin-runtime")
	const blobDir = join(storeRoot, "bun", lock.executableSha256)

	return {
		root: fixtureRoot,
		pluginRoot,
		runtimeDir,
		engine,
		cacheDir,
		storeRoot,
		blobDir,
		blobPath: join(blobDir, "bun"),
		zipPath,
		lock,
		bundles,
		env: {
			HOME: fixtureRoot,
			XDG_CACHE_HOME: cacheDir,
			PATH: "/nonexistent-hostile-path",
		},
	}
}

function runEngine(
	fixture: Fixture,
	args: string[],
	options: { env?: Record<string, string>; cwd?: string } = {},
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [fixture.engine, ...args],
		cwd: options.cwd ?? fixture.root,
		env: { ...fixture.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	})
}

function readEnvelope(result: ReturnType<typeof Bun.spawnSync>): Record<string, unknown> {
	const stdout = result.stdout.toString().trim()
	expect(stdout.split("\n")).toHaveLength(1)
	const envelope = JSON.parse(stdout) as Record<string, unknown>
	expect(envelope.schemaVersion).toBe(1)
	expect(typeof envelope.code).toBe("string")
	expect(typeof envelope.nextAction).toBe("string")
	expect(Array.isArray(envelope.sideEffects)).toBe(true)
	expect(typeof envelope.retrySafe).toBe("boolean")
	return envelope
}

const engineToolNames = [
	"uname",
	"getconf",
	"ls",
	"id",
	"wc",
	"mkdir",
	"rm",
	"mv",
	"ln",
	"chmod",
	"dd",
	"head",
	"curl",
	"unzip",
	"ps",
	"find",
	"awk",
	"sha256sum",
	"shasum",
]

function makeToolDir(overrides: Record<string, string | null> = {}): string {
	const toolDir = join(temporaryDirectory("fixture-tools-"), "bin")
	mkdirSync(toolDir)
	for (const name of engineToolNames) {
		if (name in overrides) {
			const body = overrides[name]
			if (body === null) continue
			writeFileSync(join(toolDir, name), body)
		} else {
			const real = Bun.which(name)
			if (!real) continue
			writeFileSync(join(toolDir, name), `#!/bin/sh\nexec ${real} "$@"\n`)
		}
		chmodSync(join(toolDir, name), 0o755)
	}
	return toolDir
}

// --- AE4: missing runtime ---------------------------------------------------

test("fresh run reports BUN_MISSING as one JSON envelope, exit 20, custody-read-only", () => {
	const fixture = makeFixture()
	const result = runEngine(fixture, ["run", "skill-a"])
	expect(result.exitCode).toBe(20)
	const envelope = readEnvelope(result)
	expect(envelope.ok).toBe(false)
	expect(envelope.code).toBe("BUN_MISSING")
	expect(envelope.sideEffects).toEqual([])
	expect(envelope.retrySafe).toBe(true)
	expect(String(envelope.nextAction)).toContain("repair --apply")
	// run never mutates the cache: nothing appears under the store root
	expect(readdirSync(fixture.cacheDir)).toEqual([])
	// redaction: no private absolute fixture path leaks into the envelope
	expect(result.stdout.toString()).not.toContain(fixture.root)
})

// --- AE12: unsupported platform fails closed --------------------------------

test("unsupported platform fails closed with one envelope and exit 21", () => {
	const toolDir = makeToolDir({
		uname: `#!/bin/sh\ncase "\${1-}" in -m) echo x86_64 ;; *) echo Windows_NT ;; esac\n`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	const result = runEngine(fixture, ["run", "skill-a"])
	expect(result.exitCode).toBe(21)
	const envelope = readEnvelope(result)
	expect(envelope.ok).toBe(false)
	expect(envelope.code).toBe("UNSUPPORTED_PLATFORM")
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(21)
	expect(readEnvelope(apply).code).toBe("UNSUPPORTED_PLATFORM")
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

test("musl Linux fails closed before cache or network work", () => {
	const toolDir = makeToolDir({
		uname: `#!/bin/sh\ncase "\${1-}" in -m) echo x86_64 ;; *) echo Linux ;; esac\n`,
		getconf: "#!/bin/sh\necho 'musl libc'\n",
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	for (const args of [["run", "skill-a"], ["repair"], ["repair", "--apply"]]) {
		const result = runEngine(fixture, args)
		expect(result.exitCode).toBe(21)
		expect(readEnvelope(result).code).toBe("UNSUPPORTED_PLATFORM")
	}
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

// --- R10: missing host prerequisite -----------------------------------------

test("a missing host tool yields HOST_TOOL_MISSING with exit 21 and no mutation", () => {
	const toolDir = makeToolDir({ unzip: null })
	const fixture = makeFixture({ hostToolDirs: toolDir })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(21)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("HOST_TOOL_MISSING")
	expect(String(envelope.nextAction)).toContain("unzip")
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

test("a malformed lock version yields a typed LOCK_INVALID envelope", () => {
	const fixture = makeFixture({ lockVersion: '9.9.9"injected' })
	const preview = runEngine(fixture, ["repair"])
	expect(preview.exitCode).toBe(23)
	const envelope = readEnvelope(preview)
	expect(envelope.code).toBe("LOCK_INVALID")
	expect(preview.stdout.toString()).not.toContain("injected")
})

// --- R17: ordinary help and closed command surface ---------------------------

test("help prints usage on stdout and unknown commands are a typed usage error", () => {
	const fixture = makeFixture()
	const help = runEngine(fixture, ["help"])
	expect(help.exitCode).toBe(0)
	expect(help.stdout.toString()).toContain("run <skill>")
	expect(help.stdout.toString()).toContain("repair")
	expect(help.stdout.toString()).toContain("--reclaim-foreign-lock")
	const unknown = runEngine(fixture, ["doctor"])
	expect(unknown.exitCode).toBe(2)
	expect(readEnvelope(unknown).code).toBe("USAGE")
	const unapprovedForeignReclaim = runEngine(fixture, ["repair", "--reclaim-foreign-lock"])
	expect(unapprovedForeignReclaim.exitCode).toBe(2)
	expect(readEnvelope(unapprovedForeignReclaim).code).toBe("USAGE")
	const missingSeparator = runEngine(fixture, ["run", "skill-a", "extra"])
	expect(missingSeparator.exitCode).toBe(2)
	expect(readEnvelope(missingSeparator).code).toBe("USAGE")
})

// --- shared helpers for warm-state tests --------------------------------------

function applyRepair(fixture: Fixture): Record<string, unknown> {
	// stderr is a human-diagnostics channel and may carry lines (e.g. the
	// corrupt-state diagnosis); the control object still lives on stdout alone.
	const result = runEngine(fixture, ["repair", "--apply"])
	expect(result.exitCode).toBe(0)
	return readEnvelope(result)
}

function bundleReport(result: ReturnType<typeof Bun.spawnSync>): Record<string, string> {
	const report: Record<string, string> = {}
	for (const line of result.stdout.toString().trim().split("\n")) {
		const separator = line.indexOf("=")
		if (separator > 0) report[line.slice(0, separator)] = line.slice(separator + 1)
	}
	return report
}

function hostId(): string {
	return Bun.spawnSync({ cmd: ["uname", "-n"], stdout: "pipe" }).stdout.toString().trim()
}

function startToken(pid: number): string {
	// the engine always inspects processes under LC_ALL=C; the recorded token
	// must use the same convention or lstart field order differs by locale
	const output = Bun.spawnSync({
		cmd: ["ps", "-o", "lstart=", "-p", String(pid)],
		env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
		stdout: "pipe",
	})
		.stdout.toString()
		.trim()
	return output.split(/\s+/).join(" ")
}

function writeLockRecord(
	fixture: Fixture,
	record: { pid: number; start: string; staging: string; host?: string },
): string {
	const lockDir = join(fixture.storeRoot, "locks", `bun-${fixture.lock.executableSha256}`)
	mkdirSync(lockDir, { recursive: true })
	writeFileSync(
		join(lockDir, "record"),
		`host=${record.host ?? hostId()}\npid=${record.pid}\nstart=${record.start}\nstaging=${record.staging}\n`,
	)
	return lockDir
}

// --- AE4: missing -> preview -> approved apply -> retried run -----------------

test("AE4: repair preview states a plain action, approved apply installs, retried run passes through", () => {
	const fixture = makeFixture()
	const preview = runEngine(fixture, ["repair"])
	expect(preview.exitCode).toBe(0)
	const previewEnvelope = readEnvelope(preview)
	expect(previewEnvelope.ok).toBe(true)
	expect(previewEnvelope.code).toBe("REPAIR_PREVIEW")
	expect(previewEnvelope.sideEffects).toEqual([])
	expect(String(previewEnvelope.nextAction)).toContain("repair --apply")
	expect(String(previewEnvelope.nextAction)).toContain("download")
	// preview is read-only: still nothing in the cache
	expect(readdirSync(fixture.cacheDir)).toEqual([])

	const applied = applyRepair(fixture)
	expect(applied.code).toBe("REPAIR_APPLIED")
	expect(applied.sideEffects).toEqual(["published-runtime"])
	expect(applied.state).toEqual({ before: "missing", after: "valid" })
	expect(applied.runtime).toEqual({
		version: fixture.lock.version,
		executableSha256: fixture.lock.executableSha256,
	})
	expect(existsSync(fixture.blobPath)).toBe(true)
	expect(statSync(fixture.blobDir).mode & 0o777).toBe(0o700)
	expect(statSync(fixture.blobPath).mode & 0o777).toBe(0o700)
	// staging and locks are cleaned up after publication
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])

	const run = runEngine(fixture, ["run", "skill-a", "--", "alpha", "two words"])
	expect(run.exitCode).toBe(0)
	expect(run.stderr.toString()).toBe("")
	const report = bundleReport(run)
	expect(report.skill).toBe("skill-a")
	expect(report.args).toBe("alpha two words")
	expect(run.stdout.toString()).not.toContain('"schemaVersion"')
})

// --- AE12: launched bundle stdout/stderr/exit pass through unchanged ----------

test("AE12: a launched bundle's stdout, stderr, and exit status pass through unchanged", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	const run = runEngine(fixture, ["run", "skill-a", "--", "exit7"])
	expect(run.exitCode).toBe(7)
	expect(run.stdout.toString()).toBe("bundle-out\n")
	expect(run.stderr.toString()).toBe("bundle-err\n")
})

// --- AE5: one shared verified digest across skills, offline -------------------

test("AE5: after one repair two skills share the same verified digest with no network", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	// go fully offline: remove the archive the lock points at
	rmSync(fixture.zipPath)
	const runA = runEngine(fixture, ["run", "skill-a"])
	expect(runA.exitCode).toBe(0)
	expect(bundleReport(runA).skill).toBe("skill-a")
	const runB = runEngine(fixture, ["run", "skill-b"])
	expect(runB.exitCode).toBe(0)
	expect(bundleReport(runB).skill).toBe("skill-b")
	// exactly one shared blob
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([fixture.lock.executableSha256])
})

// --- AE6: tampered blob never executes; denied repair preserves state ---------

test("AE6: a tampered blob never executes, denied repair preserves state, approved apply restores", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	const tampered = "#!/bin/sh\necho pwned\n"
	chmodSync(fixture.blobPath, 0o700)
	writeFileSync(fixture.blobPath, tampered)

	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(20)
	const envelope = readEnvelope(run)
	expect(envelope.code).toBe("REPAIR_REQUIRED")
	expect(envelope.retrySafe).toBe(true)
	expect(run.stdout.toString()).not.toContain("pwned")

	// denied approval = preview only: no side effects, tampered bytes untouched
	const preview = runEngine(fixture, ["repair"])
	expect(preview.exitCode).toBe(0)
	const previewEnvelope = readEnvelope(preview)
	expect(previewEnvelope.code).toBe("REPAIR_PREVIEW")
	expect((previewEnvelope.state as { before: string }).before).toBe("corrupt")
	expect(previewEnvelope.sideEffects).toEqual([])
	expect(readFileSync(fixture.blobPath, "utf8")).toBe(tampered)

	// approved apply verifies the replacement before publication
	const applied = applyRepair(fixture)
	expect(applied.state).toEqual({ before: "corrupt", after: "valid" })
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	const retried = runEngine(fixture, ["run", "skill-a"])
	expect(retried.exitCode).toBe(0)
	expect(bundleReport(retried).skill).toBe("skill-a")
})

test("approved repair replaces a directory-shaped corrupt blob destination", () => {
	const fixture = makeFixture()
	mkdirSync(fixture.blobPath, { recursive: true })
	writeFileSync(join(fixture.blobPath, "debris"), "not-a-runtime")

	const preview = runEngine(fixture, ["repair"])
	expect(preview.exitCode).toBe(0)
	expect((readEnvelope(preview).state as { before: string }).before).toBe("corrupt")

	const applied = applyRepair(fixture)
	expect(applied.sideEffects).toEqual(["published-runtime"])
	expect(applied.state).toEqual({ before: "corrupt", after: "valid" })
	expect(statSync(fixture.blobPath).isFile()).toBe(true)
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
})

test("a directory-shaped corrupt blob removal failure emits one envelope and cleans apply state", () => {
	const realRm = Bun.which("rm")
	if (!realRm) throw new Error("rm is required by the test fixture")
	const toolDir = makeToolDir({
		rm: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */bun/*/bun) exit 1 ;; esac
exec ${realRm} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	mkdirSync(fixture.blobPath, { recursive: true })
	writeFileSync(join(fixture.blobPath, "debris"), "not-a-runtime")

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual([])
	expect(envelope.retrySafe).toBe(true)
	expect(statSync(fixture.blobPath).isDirectory()).toBe(true)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
}, 10_000)

// --- AE7: cold offline stays read-only; apply retries later -------------------

test("AE7: cold offline run stays read-only and apply fails retry-later, then succeeds with connectivity", () => {
	const fixture = makeFixture({ url: "https://127.0.0.1:9/bun-fixture.zip" })
	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(20)
	expect(readEnvelope(run).code).toBe("BUN_MISSING")
	expect(readdirSync(fixture.cacheDir)).toEqual([])

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(22)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("DOWNLOAD_FAILED")
	expect(envelope.retrySafe).toBe(true)
	// publishes nothing and leaves no debris
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])

	// connectivity restored: same lock identity, reachable URL
	writeFixtureLock(fixture, { ...fixture.lock, url: `file://${fixture.zipPath}` })
	applyRepair(fixture)
	const retried = runEngine(fixture, ["run", "skill-a"])
	expect(retried.exitCode).toBe(0)
})

// --- AE8: concurrency, killed writer, live writer -----------------------------

test("AE8: concurrent applies publish exactly one valid blob and both callers end safely", async () => {
	const fixture = makeFixture()
	const spawnApply = () =>
		Bun.spawn({
			cmd: [fixture.engine, "repair", "--apply"],
			cwd: fixture.root,
			env: fixture.env,
			stdout: "pipe",
			stderr: "pipe",
		})
	const first = spawnApply()
	const second = spawnApply()
	const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])
	for (const exitCode of [firstExit, secondExit]) {
		expect([0, 22]).toContain(exitCode)
	}
	expect([firstExit, secondExit]).toContain(0)
	// one verified winner, no partial executable, no leftover locks or staging
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([fixture.lock.executableSha256])
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(0)
})

test("AE8: repair fails closed when its process start identity cannot be established", () => {
	const toolDir = makeToolDir({ ps: "#!/bin/sh\nexit 1\n" })
	const fixture = makeFixture({ hostToolDirs: toolDir })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual([])
	expect(String(envelope.nextAction)).toContain("process inspection")
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
})

test("AE8: a provably dead writer's lock is reclaimed with only its staging removed", () => {
	const fixture = makeFixture()
	// a reaped process: provably dead pid with a mismatching start token
	const dead = Bun.spawnSync({ cmd: ["sh", "-c", ":"], stdout: "pipe" })
	const deadPid = dead.pid ?? 99999
	mkdirSync(join(fixture.storeRoot, "staging", "stalenonce"), { recursive: true })
	writeFileSync(join(fixture.storeRoot, "staging", "stalenonce", "bun"), "partial-bytes")
	mkdirSync(join(fixture.storeRoot, "staging", "othernonce"), { recursive: true })
	writeLockRecord(fixture, {
		pid: deadPid,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})

	const applied = applyRepair(fixture)
	expect(applied.code).toBe("REPAIR_APPLIED")
	expect(applied.sideEffects).toEqual(["reclaimed-stale-lock", "published-runtime"])
	// only the dead writer's staging was removed
	expect(existsSync(join(fixture.storeRoot, "staging", "stalenonce"))).toBe(false)
	expect(existsSync(join(fixture.storeRoot, "staging", "othernonce"))).toBe(true)
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
})

test("an abandoned stale-lock reclaim marker fails closed without unlinking inspected state", () => {
	const fixture = makeFixture()
	const lockDir = writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})
	const marker = join(lockDir, ".reclaim-claim")
	writeFileSync(
		marker,
		`host=${hostId()}\npid=999999\nstart=Thu Jan 1 00:00:00 1970\nnonce=dead-claimant\n`,
	)
	const old = new Date(Date.now() - 2 * 60 * 1000)
	utimesSync(marker, old, old)

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual([])
	expect(envelope.retrySafe).toBe(false)
	expect(String(envelope.nextAction)).toContain("approve removal")
	expect(existsSync(marker)).toBe(true)
})

test("a live reclaim claimant remains protected after the grace period", () => {
	const fixture = makeFixture()
	const lockDir = writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})
	const marker = join(lockDir, ".reclaim-claim")
	writeFileSync(
		marker,
		`host=${hostId()}\npid=${process.pid}\nstart=${startToken(process.pid)}\nnonce=paused-live-claimant\n`,
	)
	const old = new Date(Date.now() - 2 * 60 * 1000)
	utimesSync(marker, old, old)

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(22)
	expect(readEnvelope(apply).code).toBe("LOCK_HELD")
	expect(existsSync(marker)).toBe(true)
})

test("concurrent stale-lock reclaimers cannot claim a replacement lock", async () => {
	const realMv = Bun.which("mv")
	if (!realMv) throw new Error("mv is required by the test fixture")
	const signal = join(temporaryDirectory("reclaim-contention-"), "record-published")
	const release = join(temporaryDirectory("reclaim-contention-release-"), "continue")
	const toolDir = makeToolDir({
		mv: `#!/bin/sh
${realMv} "$@" || exit $?
last=''
for arg in "$@"; do last=$arg; done
case "\${PAUSE_AFTER_LOCK_RECORD-}:$last" in
1:*/locks/bun-*/record)
	: >"$LOCK_RECORD_SIGNAL"
	while [ ! -f "$LOCK_RECORD_RELEASE" ]; do /bin/sleep 0.01; done
	;;
esac
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})
	const spawnApply = (env: Record<string, string> = {}) =>
		Bun.spawn({
			cmd: [fixture.engine, "repair", "--apply"],
			cwd: fixture.root,
			env: { ...fixture.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		})
	const first = spawnApply({
		PAUSE_AFTER_LOCK_RECORD: "1",
		LOCK_RECORD_SIGNAL: signal,
		LOCK_RECORD_RELEASE: release,
	})
	try {
		for (let attempt = 0; attempt < 500 && !existsSync(signal); attempt++) await Bun.sleep(10)
		expect(existsSync(signal)).toBe(true)
		const second = spawnApply()
		expect(await second.exited).toBe(22)
	} finally {
		writeFileSync(release, "continue\n")
	}
	expect(await first.exited).toBe(0)
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
})

test("a stale lock replaced by a live writer is revalidated before reclamation", () => {
	const realWc = Bun.which("wc")
	if (!realWc) throw new Error("wc is required by the test fixture")
	const liveHost = hostId()
	const liveStart = startToken(process.pid)
	const toolDir = makeToolDir({
		wc: `#!/bin/sh
count_file="$XDG_CACHE_HOME/lock-record-read-count"
count=0
if [ -f "$count_file" ]; then IFS= read -r count <"$count_file" || count=0; fi
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
if [ "$count" -eq 2 ]; then
	for record in "$XDG_CACHE_HOME"/agent-plugin-runtime/locks/bun-*/record; do
		printf 'host=%s\npid=%s\nstart=%s\nstaging=%s\n' '${liveHost}' '${process.pid}' '${liveStart}' 'livenonce' >"$record"
		break
	done
fi
exec ${realWc} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	const lockDir = writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(22)
	expect(readEnvelope(apply).code).toBe("LOCK_HELD")
	expect(readFileSync(join(lockDir, "record"), "utf8")).toContain("staging=livenonce")
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("a stale writer staging cleanup failure emits one envelope after freeing the lock", () => {
	const realRm = Bun.which("rm")
	if (!realRm) throw new Error("rm is required by the test fixture")
	const toolDir = makeToolDir({
		rm: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */staging/stalenonce) exit 1 ;; esac
exec ${realRm} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	mkdirSync(join(fixture.storeRoot, "staging", "stalenonce"), { recursive: true })
	writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual(["reclaimed-stale-lock"])
	expect(envelope.retrySafe).toBe(true)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(existsSync(join(fixture.storeRoot, "staging", "stalenonce"))).toBe(true)
	expect(existsSync(fixture.blobPath)).toBe(false)
	const retried = applyRepair(fixture)
	expect(retried.code).toBe("REPAIR_APPLIED")
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
})

test("a claimed stale-lock cleanup failure emits one envelope after clearing staging", () => {
	const realRm = Bun.which("rm")
	if (!realRm) throw new Error("rm is required by the test fixture")
	const toolDir = makeToolDir({
		rm: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */locks/reclaim-*) exit 1 ;; esac
exec ${realRm} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	mkdirSync(join(fixture.storeRoot, "staging", "stalenonce"), { recursive: true })
	writeLockRecord(fixture, {
		pid: 999999,
		start: "Thu Jan 1 00:00:00 1970",
		staging: "stalenonce",
	})

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual(["reclaimed-stale-lock"])
	expect(envelope.retrySafe).toBe(true)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toHaveLength(1)
	expect(existsSync(join(fixture.storeRoot, "staging", "stalenonce"))).toBe(false)
	expect(existsSync(fixture.blobPath)).toBe(false)
	const retried = applyRepair(fixture)
	expect(retried.code).toBe("REPAIR_APPLIED")
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
})

test("a foreign-host lock requires separate approval before bounded reclamation", () => {
	const fixture = makeFixture()
	mkdirSync(join(fixture.storeRoot, "staging", "foreignnonce"), { recursive: true })
	writeFileSync(join(fixture.storeRoot, "staging", "foreignnonce", "bun"), "partial-bytes")
	const lockDir = writeLockRecord(fixture, {
		host: "retired-host",
		pid: process.pid,
		start: startToken(process.pid),
		staging: "foreignnonce",
	})

	const blocked = runEngine(fixture, ["repair", "--apply"])
	expect(blocked.exitCode).toBe(20)
	const blockedEnvelope = readEnvelope(blocked)
	expect(blockedEnvelope.code).toBe("FOREIGN_LOCK_REQUIRES_APPROVAL")
	expect(blockedEnvelope.sideEffects).toEqual([])
	expect(blockedEnvelope.retrySafe).toBe(false)
	expect(String(blockedEnvelope.nextAction)).toContain("--reclaim-foreign-lock")
	expect(existsSync(lockDir)).toBe(true)
	expect(existsSync(join(fixture.storeRoot, "staging", "foreignnonce"))).toBe(true)
	expect(existsSync(fixture.blobPath)).toBe(false)

	const approved = runEngine(fixture, ["repair", "--apply", "--reclaim-foreign-lock"])
	expect(approved.exitCode).toBe(0)
	const approvedEnvelope = readEnvelope(approved)
	expect(approvedEnvelope.code).toBe("REPAIR_APPLIED")
	expect(approvedEnvelope.sideEffects).toEqual(["reclaimed-stale-lock", "published-runtime"])
	expect(existsSync(lockDir)).toBe(false)
	expect(existsSync(join(fixture.storeRoot, "staging", "foreignnonce"))).toBe(false)
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
})

test("AE8: a live writer's lock is never reclaimed", async () => {
	const fixture = makeFixture()
	const sleeper = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" })
	try {
		const lockDir = writeLockRecord(fixture, {
			pid: sleeper.pid,
			start: startToken(sleeper.pid),
			staging: "livenonce",
		})
		const apply = runEngine(fixture, ["repair", "--apply"])
		expect(apply.exitCode).toBe(22)
		const envelope = readEnvelope(apply)
		expect(envelope.code).toBe("LOCK_HELD")
		expect(envelope.retrySafe).toBe(true)
		// the live writer's lock and record are untouched, nothing published
		expect(existsSync(join(lockDir, "record"))).toBe(true)
		expect(existsSync(fixture.blobPath)).toBe(false)
		const explicitlyScoped = runEngine(fixture, ["repair", "--apply", "--reclaim-foreign-lock"])
		expect(explicitlyScoped.exitCode).toBe(22)
		expect(readEnvelope(explicitlyScoped).code).toBe("LOCK_HELD")
		expect(existsSync(join(lockDir, "record"))).toBe(true)
	} finally {
		sleeper.kill()
		await sleeper.exited
	}
})

test("AE8: a writer remains live when its start identity cannot be re-inspected", () => {
	const toolDir = makeToolDir({ ps: "#!/bin/sh\nexit 1\n" })
	const fixture = makeFixture({ hostToolDirs: toolDir })
	const lockDir = writeLockRecord(fixture, {
		pid: process.pid,
		start: startToken(process.pid),
		staging: "livewriter",
	})

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(22)
	expect(readEnvelope(apply).code).toBe("LOCK_HELD")
	expect(existsSync(lockDir)).toBe(true)
})

test("a symlink-shaped repair lock is rejected without touching its target", () => {
	const fixture = makeFixture()
	const externalLock = temporaryDirectory("external-repair-lock-")
	writeFileSync(
		join(externalLock, "record"),
		`host=${hostId()}\npid=999999\nstart=Thu Jan 1 00:00:00 1970\nstaging=stalenonce\n`,
	)
	const lockRoot = join(fixture.storeRoot, "locks")
	mkdirSync(lockRoot, { recursive: true })
	const lockPath = join(lockRoot, `bun-${fixture.lock.executableSha256}`)
	symlinkSync(externalLock, lockPath)

	const applied = runEngine(fixture, ["repair", "--apply"])
	expect(applied.exitCode).toBe(20)
	const envelope = readEnvelope(applied)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual([])
	expect(lstatSync(lockPath).isSymbolicLink()).toBe(true)
	expect(readdirSync(externalLock)).toEqual(["record"])
	expect(existsSync(join(externalLock, ".reclaim-claim"))).toBe(false)
})

test("an unreadable existing lock record emits one envelope without reclaiming it", () => {
	const toolDir = makeToolDir({
		wc: "#!/bin/sh\nexit 1\n",
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })
	const lockDir = writeLockRecord(fixture, {
		pid: process.pid,
		start: startToken(process.pid),
		staging: "livenonce",
	})
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual([])
	expect(envelope.retrySafe).toBe(true)
	expect(String(envelope.nextAction)).toContain("owner-readable")
	expect(existsSync(lockDir)).toBe(true)
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("AE8: a fresh recordless lock is treated as live and repair returns retry-later", () => {
	const fixture = makeFixture()
	// A writer between mkdir and its atomic record publish leaves a recordless
	// lock. Within the grace window it must be treated as live: retry is safe,
	// nothing is reclaimed or published.
	const lockDir = join(fixture.storeRoot, "locks", `bun-${fixture.lock.executableSha256}`)
	mkdirSync(lockDir, { recursive: true })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(22)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("LOCK_HELD")
	expect(envelope.retrySafe).toBe(true)
	expect(existsSync(fixture.blobPath)).toBe(false)
	expect(existsSync(lockDir)).toBe(true)
})

test("AE8: a recordless lock older than the grace window is reclaimed (integer -mmin, BSD-safe)", () => {
	const fixture = makeFixture()
	// A writer that died before publishing its record leaves a recordless lock
	// forever unless the grace window reclaims it. This is the exact path the
	// fractional -mmin argument silently broke on macOS/BSD find; backdate the
	// lock past the grace window and assert reclaim + publish.
	const lockDir = join(fixture.storeRoot, "locks", `bun-${fixture.lock.executableSha256}`)
	mkdirSync(lockDir, { recursive: true })
	const aged = new Date(Date.now() - 5 * 60 * 1000)
	utimesSync(lockDir, aged, aged)

	const applied = applyRepair(fixture)
	expect(applied.code).toBe("REPAIR_APPLIED")
	expect(applied.sideEffects).toEqual(["reclaimed-stale-lock", "published-runtime"])
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
})

test("a lock-record publication failure emits one envelope and releases the lock", () => {
	const realMv = Bun.which("mv")
	if (!realMv) throw new Error("mv is required by the test fixture")
	const toolDir = makeToolDir({
		mv: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */record) exit 1 ;; esac
exec ${realMv} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("a staged chmod failure emits one envelope and releases apply state", () => {
	const toolDir = makeToolDir({
		chmod: "#!/bin/sh\nexit 1\n",
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("a post-publication staging cleanup failure still emits one envelope and releases the lock", () => {
	const realRm = Bun.which("rm")
	if (!realRm) throw new Error("rm is required by the test fixture")
	const toolDir = makeToolDir({
		rm: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */staging/*) exit 1 ;; esac
exec ${realRm} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual(["published-runtime"])
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toHaveLength(1)
})

test("a post-publication lock cleanup failure still emits one envelope after clearing staging", () => {
	const realRm = Bun.which("rm")
	if (!realRm) throw new Error("rm is required by the test fixture")
	const toolDir = makeToolDir({
		rm: `#!/bin/sh
last=''
for arg in "$@"; do last=$arg; done
case "$last" in */locks/bun-*) exit 1 ;; esac
exec ${realRm} "$@"
`,
	})
	const fixture = makeFixture({ hostToolDirs: toolDir })

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
	expect(envelope.sideEffects).toEqual(["published-runtime"])
	expect(sha256Hex(readFileSync(fixture.blobPath))).toBe(fixture.lock.executableSha256)
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toHaveLength(1)
})

// --- run stays custody-read-only, including on a read-only cache --------------

test("run does not write into the custody store and launches from a read-only cache", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	// Snapshot the store, then make the whole store tree read-only. A valid blob
	// must still launch: run must not create any file under the store.
	const before = readdirSync(fixture.storeRoot).sort()
	const readOnlyPaths = [
		fixture.storeRoot,
		join(fixture.storeRoot, "bun"),
		fixture.blobDir,
		join(fixture.storeRoot, "locks"),
		join(fixture.storeRoot, "staging"),
	]
	try {
		for (const path of readOnlyPaths) chmodSync(path, 0o500)
		const run = runEngine(fixture, ["run", "skill-a", "--", "alpha"])
		expect(run.exitCode).toBe(0)
		expect(run.stderr.toString()).toBe("")
		expect(bundleReport(run).skill).toBe("skill-a")
	} finally {
		for (const path of readOnlyPaths) chmodSync(path, 0o700)
	}
	// no new custody-store state was created by run
	expect(readdirSync(fixture.storeRoot).sort()).toEqual(before)
	expect(existsSync(join(fixture.storeRoot, "empty-bunfig.toml"))).toBe(false)
})

test("successful run creates no transient config directory", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	const launchTemp = temporaryDirectory("runtime-launch-tmp-")
	const run = runEngine(fixture, ["run", "skill-a"], { env: { TMPDIR: launchTemp } })
	expect(run.exitCode).toBe(0)
	expect(readdirSync(launchTemp)).toEqual([])
})

test("run restores the caller umask for the launched skill", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	// Custody tightens umask to 077 for its own writes; the launched skill must
	// see the caller umask, not the custody one. The caller umask is whatever the
	// engine was invoked under (inherited from this test process); a sibling
	// shell launched the same way reports it. The launched skill must match that.
	const callerUmask = Bun.spawnSync({
		cmd: ["/bin/sh", "-c", "umask"],
		env: { ...fixture.env },
		stdout: "pipe",
	})
		.stdout.toString()
		.trim()
	const run = runEngine(fixture, ["run", "skill-a", "--", "alpha"])
	expect(run.exitCode).toBe(0)
	expect(bundleReport(run).umask).toBe(callerUmask)
})

// --- AE9: hostile caller environment cannot alter custody ---------------------

test("AE9: hostile env, PATH, and cwd cannot alter custody; app env is preserved for the skill", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	const hostileTools = makeToolDir({
		uname: "#!/bin/sh\nexit 42\n",
		curl: "#!/bin/sh\nexit 42\n",
		shasum: "#!/bin/sh\nexit 42\n",
		sha256sum: "#!/bin/sh\nexit 42\n",
	})
	const hostileCwd = join(temporaryDirectory("hostile-cwd-"), "app")
	mkdirSync(join(hostileCwd, "node_modules"), { recursive: true })
	writeFileSync(join(hostileCwd, ".env"), "EVIL=1\n")
	// Top-level preload is the shape Bun honors for a direct `bun <script>` run;
	// a [run] table is ignored, so the earlier fixture never exercised the vector.
	writeFileSync(
		join(hostileCwd, "evil.ts"),
		'console.error("EVIL_PRELOAD_RAN");\nprocess.exit(99);\n',
	)
	writeFileSync(join(hostileCwd, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
	const run = runEngine(fixture, ["run", "skill-a"], {
		cwd: hostileCwd,
		env: {
			PATH: hostileTools,
			BUN_OPTIONS: "--preload ./evil.ts",
			NODE_OPTIONS: "--require ./evil.js",
			BUN_INSTALL: join(hostileCwd, "bun-install"),
			NODE_PATH: hostileCwd,
		},
	})
	// The hostile cwd bunfig preload must never run inside the verified runtime.
	expect(run.stderr.toString()).not.toContain("EVIL_PRELOAD_RAN")
	expect(run.stderr.toString()).toBe("")
	expect(run.exitCode).toBe(0)
	const report = bundleReport(run)
	expect(report.skill).toBe("skill-a")
	// ambient control surfaces are suppressed for the launched runtime
	expect(report.BUN_OPTIONS).toBe("unset")
	expect(report.NODE_OPTIONS).toBe("unset")
	expect(report.DO_NOT_TRACK).toBe("1")
	expect(report.bunflags).toContain("--no-install")
	expect(report.bunflags).toContain("--env-file=/dev/null")
	expect(report.bunflags).toContain("--config=")
	// ordinary app environment is preserved: caller cwd and caller PATH
	expect(report.cwd).toBe(hostileCwd)
	expect(report.PATH).toBe(hostileTools)
})

test("verified launch ignores hostile HOME and XDG global bunfig preloads", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	writeFileSync(join(fixture.root, ".bunfig.toml"), 'preload = ["./evil-home.ts"]\n')
	const homeRun = runEngine(fixture, ["run", "skill-a"])
	expect(homeRun.exitCode).toBe(0)
	expect(homeRun.stderr.toString()).not.toContain("HOSTILE_BUNFIG_RAN")

	rmSync(join(fixture.root, ".bunfig.toml"))
	const xdgConfigHome = join(fixture.root, "xdg-config")
	mkdirSync(xdgConfigHome)
	writeFileSync(join(xdgConfigHome, ".bunfig.toml"), 'preload = ["./evil-xdg.ts"]\n')
	const xdgRun = runEngine(fixture, ["run", "skill-a"], {
		env: { XDG_CONFIG_HOME: xdgConfigHome },
	})
	expect(xdgRun.exitCode).toBe(0)
	expect(xdgRun.stderr.toString()).not.toContain("HOSTILE_BUNFIG_RAN")
})

test("repair version verification ignores hostile Bun options and cwd config", () => {
	const fixture = makeFixture()
	const hostileCwd = join(temporaryDirectory("hostile-repair-cwd-"), "app")
	mkdirSync(hostileCwd)
	writeFileSync(join(hostileCwd, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
	const apply = runEngine(fixture, ["repair", "--apply"], {
		cwd: hostileCwd,
		env: { BUN_OPTIONS: "--preload ./evil.ts" },
	})
	expect(apply.exitCode).toBe(0)
	expect(readEnvelope(apply).code).toBe("REPAIR_APPLIED")
})

// --- AE11: a fresh lock identity never mutates on run -------------------------

test("AE11: a changed lock identity produces the repair path and preserves the prior blob", () => {
	const fixture = makeFixture()
	applyRepair(fixture)
	const priorBlobPath = fixture.blobPath

	// review lands a new runtime identity: new version, new bytes, new digest
	const nextBun = new TextEncoder().encode(fixtureBunScript("9.9.10"))
	const nextZip = storedZip([{ name: fixture.lock.executablePath, data: nextBun }])
	const nextZipPath = join(fixture.root, "assets", "bun-next.zip")
	writeFileSync(nextZipPath, nextZip)
	const nextLock: FixtureLock = {
		...fixture.lock,
		version: "9.9.10",
		url: `file://${nextZipPath}`,
		archiveName: "bun-next.zip",
		archiveBytes: nextZip.length,
		archiveSha256: sha256Hex(nextZip),
		executableBytes: nextBun.length,
		executableSha256: sha256Hex(nextBun),
	}
	writeFixtureLock(fixture, nextLock)

	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(20)
	expect(readEnvelope(run).code).toBe("BUN_MISSING")
	// prior valid blob is preserved untouched
	expect(sha256Hex(readFileSync(priorBlobPath))).toBe(fixture.lock.executableSha256)

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(0)
	const nextBlobPath = join(fixture.storeRoot, "bun", nextLock.executableSha256, "bun")
	expect(sha256Hex(readFileSync(nextBlobPath))).toBe(nextLock.executableSha256)
	expect(existsSync(priorBlobPath)).toBe(true)
	const retried = runEngine(fixture, ["run", "skill-b"])
	expect(retried.exitCode).toBe(0)
	expect(bundleReport(retried).skill).toBe("skill-b")
})

// --- AE12: release-contract failures fail closed with exit 23 -----------------

test("AE12: unknown skills, unmapped bundles, and tampered bundles fail closed with exit 23", () => {
	const fixture = makeFixture({ extraCatalogSkills: ["skill-c"] })
	applyRepair(fixture)

	const unknown = runEngine(fixture, ["run", "skill-z"])
	expect(unknown.exitCode).toBe(23)
	expect(readEnvelope(unknown).code).toBe("SKILL_UNKNOWN")

	const hostileId = runEngine(fixture, ["run", "evil;rm -rf /"])
	expect(hostileId.exitCode).toBe(23)
	expect(readEnvelope(hostileId).code).toBe("SKILL_UNKNOWN")
	expect(hostileId.stdout.toString()).not.toContain("rm -rf")

	// in the catalog but absent from the bundle inventory
	const unmapped = runEngine(fixture, ["run", "skill-c"])
	expect(unmapped.exitCode).toBe(23)
	expect(readEnvelope(unmapped).code).toBe("BUNDLE_UNMAPPED")

	// tampered bundle bytes never execute
	const bundleFile = join(fixture.pluginRoot, fixture.bundles["skill-a"].path)
	writeFileSync(bundleFile, `${readFileSync(bundleFile, "utf8")}\n# tampered\n`)
	const tampered = runEngine(fixture, ["run", "skill-a"])
	expect(tampered.exitCode).toBe(23)
	expect(readEnvelope(tampered).code).toBe("BUNDLE_MISMATCH")
	expect(tampered.stdout.toString()).not.toContain("skill=skill-a")
})

// --- R11/R12 negatives: acquisition verification ------------------------------

test("a wrong archive size is rejected before extraction with exit 23", () => {
	const fixture = makeFixture()
	fixture.lock.archiveBytes -= 1
	writeFixtureLock(fixture, fixture.lock)
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("ARCHIVE_SIZE_MISMATCH")
	expect(existsSync(fixture.blobPath)).toBe(false)
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
})

test("an oversized-lock archive that downloads whole still fails verify_archive with exit 23", () => {
	// Recording MORE bytes than the archive holds keeps curl's --max-filesize
	// cap above the real size, so the download completes and verify_archive's
	// own post-download size check is the guard that rejects the mismatch --
	// exercising a path the undersized-lock case can never reach.
	const fixture = makeFixture()
	fixture.lock.archiveBytes += 1
	writeFixtureLock(fixture, fixture.lock)
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("ARCHIVE_SIZE_MISMATCH")
	expect(existsSync(fixture.blobPath)).toBe(false)
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
})

test("a wrong archive hash is rejected before extraction with exit 23", () => {
	const fixture = makeFixture({ lock: { archiveSha256: "0".repeat(64) } })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("ARCHIVE_HASH_MISMATCH")
	expect(existsSync(fixture.blobPath)).toBe(false)
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
})

test("ambiguous duplicate archive members are rejected with exit 23", () => {
	const member = "bun-fixture/bun"
	const bunBytes = new TextEncoder().encode(fixtureBunScript(FIXTURE_BUN_VERSION))
	const fixture = makeFixture({
		zipEntries: [
			{ name: member, data: bunBytes },
			{ name: member, data: new TextEncoder().encode("#!/bin/sh\necho evil\n") },
		],
		lock: {},
	})
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("ARCHIVE_MEMBER_AMBIGUOUS")
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("an archive without the locked executable member is rejected with exit 23", () => {
	const bunBytes = new TextEncoder().encode(fixtureBunScript(FIXTURE_BUN_VERSION))
	const fixture = makeFixture({
		zipEntries: [{ name: "somewhere-else/bun", data: bunBytes }],
	})
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("ARCHIVE_MEMBER_MISSING")
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("an extracted-byte overrun is capped and rejected with exit 23", () => {
	const fixture = makeFixture()
	fixture.lock.executableBytes -= 10
	writeFixtureLock(fixture, fixture.lock)
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("EXECUTABLE_SIZE_MISMATCH")
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([])
})

test("a wrong executable hash is rejected before publication with exit 23", () => {
	const fixture = makeFixture({ lock: { executableSha256: "f".repeat(64) } })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("EXECUTABLE_HASH_MISMATCH")
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([])
})

test("a wrong --version report is rejected before publication with exit 23", () => {
	const fixture = makeFixture({ bunVersion: "9.9.9", lockVersion: "8.8.8" })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("EXECUTABLE_VERSION_MISMATCH")
	expect(readdirSync(join(fixture.storeRoot, "bun"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
})

test("verified staged bytes that cannot execute report the cache filesystem failure", () => {
	const unlaunchable = new TextEncoder().encode("#!/missing-runtime-interpreter\n")
	const fixture = makeFixture({
		zipEntries: [{ name: "bun-fixture/bun", data: unlaunchable }],
		lock: {
			executableBytes: unlaunchable.length,
			executableSha256: sha256Hex(unlaunchable),
		},
	})

	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(21)
	const envelope = readEnvelope(apply)
	expect(envelope.code).toBe("RUNTIME_NOT_EXECUTABLE")
	expect(envelope.retrySafe).toBe(false)
	expect(String(envelope.nextAction)).toContain("XDG_CACHE_HOME")
	expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	expect(existsSync(fixture.blobPath)).toBe(false)
})

// --- R13 negatives: unsafe cache roots ----------------------------------------

test("a world-writable cache root is rejected for run and repair with exit 20", () => {
	const fixture = makeFixture()
	chmodSync(fixture.cacheDir, 0o777)
	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(20)
	expect(readEnvelope(run).code).toBe("CACHE_ROOT_UNSAFE")
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
	expect(existsSync(fixture.blobPath)).toBe(false)
})

test("an unwritable lock root is a cache failure rather than false contention", () => {
	const fixture = makeFixture()
	mkdirSync(join(fixture.storeRoot, "bun"), { recursive: true, mode: 0o700 })
	const lockRoot = join(fixture.storeRoot, "locks")
	mkdirSync(lockRoot, { mode: 0o700 })
	mkdirSync(join(fixture.storeRoot, "staging"), { mode: 0o700 })
	chmodSync(lockRoot, 0o500)
	try {
		const apply = runEngine(fixture, ["repair", "--apply"])
		expect(apply.exitCode).toBe(20)
		const envelope = readEnvelope(apply)
		expect(envelope.code).toBe("CACHE_ROOT_UNSAFE")
		expect(envelope.sideEffects).toEqual([])
		expect(existsSync(fixture.blobPath)).toBe(false)
	} finally {
		chmodSync(lockRoot, 0o700)
	}
})

test("an unwritable staging root fails with one envelope and releases its lock", () => {
	const fixture = makeFixture()
	mkdirSync(join(fixture.storeRoot, "bun"), { recursive: true, mode: 0o700 })
	mkdirSync(join(fixture.storeRoot, "locks"), { mode: 0o700 })
	const stagingRoot = join(fixture.storeRoot, "staging")
	mkdirSync(stagingRoot, { mode: 0o700 })
	chmodSync(stagingRoot, 0o500)
	try {
		const apply = runEngine(fixture, ["repair", "--apply"])
		expect(apply.exitCode).toBe(20)
		expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
		expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
	} finally {
		chmodSync(stagingRoot, 0o700)
	}
})

test("an unwritable blob root fails with one envelope and releases apply state", () => {
	const fixture = makeFixture()
	const blobRoot = join(fixture.storeRoot, "bun")
	mkdirSync(blobRoot, { recursive: true, mode: 0o700 })
	mkdirSync(join(fixture.storeRoot, "locks"), { mode: 0o700 })
	mkdirSync(join(fixture.storeRoot, "staging"), { mode: 0o700 })
	chmodSync(blobRoot, 0o500)
	try {
		const apply = runEngine(fixture, ["repair", "--apply"])
		expect(apply.exitCode).toBe(20)
		expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
		expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
		expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	} finally {
		chmodSync(blobRoot, 0o700)
	}
})

test("an unwritable digest directory fails publication with one envelope and cleanup", () => {
	const fixture = makeFixture()
	mkdirSync(fixture.blobDir, { recursive: true, mode: 0o700 })
	chmodSync(fixture.blobDir, 0o500)
	try {
		const apply = runEngine(fixture, ["repair", "--apply"])
		expect(apply.exitCode).toBe(20)
		expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
		expect(readdirSync(join(fixture.storeRoot, "locks"))).toEqual([])
		expect(readdirSync(join(fixture.storeRoot, "staging"))).toEqual([])
	} finally {
		chmodSync(fixture.blobDir, 0o700)
	}
})

test("a symlinked store root is rejected with exit 20", () => {
	const fixture = makeFixture()
	const realStore = join(fixture.root, "elsewhere")
	mkdirSync(realStore)
	symlinkSync(realStore, fixture.storeRoot)
	const run = runEngine(fixture, ["run", "skill-a"])
	expect(run.exitCode).toBe(20)
	expect(readEnvelope(run).code).toBe("CACHE_ROOT_UNSAFE")
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(20)
	expect(readEnvelope(apply).code).toBe("CACHE_ROOT_UNSAFE")
	expect(readdirSync(realStore)).toEqual([])
})

// --- R11 negatives: transport custody -----------------------------------------

test("an http URL in the lock is rejected without any download, exit 23", () => {
	const fixture = makeFixture({ url: "http://127.0.0.1:9/bun-fixture.zip" })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("URL_REJECTED")
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

test("a file URL is rejected by the production transport policy", () => {
	const fixture = makeFixture({ allowFileUrlsForTests: false })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("URL_REJECTED")
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

test("a credential-bearing URL is rejected and never echoed, exit 23", () => {
	const fixture = makeFixture({ url: "https://user:s3cret@example.com/bun-fixture.zip" })
	const apply = runEngine(fixture, ["repair", "--apply"])
	expect(apply.exitCode).toBe(23)
	expect(readEnvelope(apply).code).toBe("URL_REJECTED")
	expect(apply.stdout.toString()).not.toContain("s3cret")
	expect(apply.stderr.toString()).not.toContain("s3cret")
	expect(readdirSync(fixture.cacheDir)).toEqual([])
})

// --- the real payload keeps the https-only release contract -------------------

test("the real runtime lock projection pins only official https release URLs", () => {
	const text = readFileSync(join(root, "plugin", "runtime", "runtime-lock.sh"), "utf8")
	const urls = [...text.matchAll(/RUNTIME_ASSET_URL='([^']+)'/g)].map((match) => match[1])
	expect(urls).toHaveLength(4)
	for (const url of urls) {
		expect(url.startsWith("https://github.com/oven-sh/bun/releases/download/")).toBe(true)
	}
})

test("the real payload ships an executable engine and a matching inventory projection", () => {
	expect(statSync(engineSourcePath).mode & 0o111).not.toBe(0)
	const projection = readFileSync(join(root, "plugin", "runtime", "bundle-inventory.sh"), "utf8")
	const inventory = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	) as { bundles: Record<string, { path: string; bytes: number; sha256: string }> }
	for (const [skillId, record] of Object.entries(inventory.bundles)) {
		expect(projection).toContain(`\t'${skillId}')`)
		expect(projection).toContain(`RUNTIME_BUNDLE_PATH='${record.path}'`)
		expect(projection).toContain(`RUNTIME_BUNDLE_SHA256='${record.sha256}'`)
	}
})
