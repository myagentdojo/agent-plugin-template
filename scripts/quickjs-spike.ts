import { mkdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const sourceRoot = join(root, "runtime", "src")
const pluginRuntime = join(root, "plugin", "runtime")
const developmentRoot = join(root, ".dev", "quickjs-compatibility")

interface Asset {
	file: string
	sha256: string
	bytes: number
}

interface AssetManifest {
	version: string
	assets: Record<string, Asset>
}

interface SpikeState {
	question: string
	host: string
	quickjsVersion: string
	asset: string
	verifiedDigest: boolean
	bundleBytes: number
	runtimeBytes: number
	helloEquivalent: boolean
	hookEquivalent: boolean
	verdict: "compatible" | "incompatible"
}

function hostKey(): string {
	const operatingSystem = process.platform === "darwin" ? "darwin" : process.platform
	const architecture = process.arch === "arm64" ? "arm64" : "x64"
	return `${operatingSystem}-${architecture}`
}

function run(
	command: string[],
	standardInput = "",
): { exitCode: number; stdout: string; stderr: string } {
	const process_ = Bun.spawnSync({
		cmd: command,
		cwd: root,
		env: { ...process.env, HELLO_WORLD_RUN_ID: "compatibility-proof" },
		stdin: Buffer.from(standardInput),
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: process_.exitCode,
		stdout: process_.stdout.toString(),
		stderr: process_.stderr.toString(),
	}
}

async function prove(): Promise<SpikeState> {
	const manifest = JSON.parse(
		readFileSync(join(pluginRuntime, "quickjs-assets.json"), "utf8"),
	) as AssetManifest
	const asset = manifest.assets[hostKey()]
	if (!asset) throw new Error(`portable runtime does not support ${hostKey()}`)
	const quickjsPath = join(pluginRuntime, asset.file)
	const quickjsBytes = readFileSync(quickjsPath)
	const digest = new Bun.CryptoHasher("sha256").update(quickjsBytes).digest("hex")
	if (digest !== asset.sha256) throw new Error(`QuickJS digest mismatch for ${asset.file}`)

	const productionBuild = Bun.spawnSync({
		cmd: ["bun", "run", "build"],
		cwd: root,
		stdout: "ignore",
		stderr: "inherit",
	})
	if (productionBuild.exitCode !== 0) process.exit(productionBuild.exitCode)

	mkdirSync(developmentRoot, { recursive: true })
	const bunBuild = await Bun.build({
		entrypoints: [join(sourceRoot, "bun-proof-adapter.ts")],
		outdir: developmentRoot,
		naming: "hello-world.bun.js",
		target: "bun",
		format: "esm",
		minify: true,
	})
	if (!bunBuild.success) {
		for (const log of bunBuild.logs) console.error(log)
		process.exit(1)
	}

	const bunBundle = join(developmentRoot, "hello-world.bun.js")
	const quickjsBundle = join(pluginRuntime, "hello-world.js")
	const helloArguments = ["hello", "--name", "plugin", "--json"]
	const bunHello = run(["bun", bunBundle, ...helloArguments])
	const quickjsHello = run([quickjsPath, "--std", quickjsBundle, ...helloArguments])
	const hookArguments = ["hook", "--harness", "codex", "--event", "SessionStart"]
	const hookInput = '{"session_id":"quickjs-compatibility"}\n'
	const bunHook = run(["bun", bunBundle, ...hookArguments], hookInput)
	const quickjsHook = run([quickjsPath, "--std", quickjsBundle, ...hookArguments], hookInput)

	const helloEquivalent = JSON.stringify(bunHello) === JSON.stringify(quickjsHello)
	const hookEquivalent = JSON.stringify(bunHook) === JSON.stringify(quickjsHook)
	return {
		question: "Can Bun-authored command and hook contracts run unchanged under QuickJS?",
		host: hostKey(),
		quickjsVersion: manifest.version,
		asset: asset.file,
		verifiedDigest: true,
		bundleBytes: statSync(quickjsBundle).size,
		runtimeBytes: statSync(quickjsPath).size,
		helloEquivalent,
		hookEquivalent,
		verdict: helloEquivalent && hookEquivalent ? "compatible" : "incompatible",
	}
}

function render(state: SpikeState): void {
	console.clear()
	console.log("\u001b[1mQuickJS compatibility proof\u001b[0m")
	console.log(`\u001b[2m${state.question}\u001b[0m\n`)
	for (const [key, value] of Object.entries(state)) {
		if (key === "question") continue
		console.log(`\u001b[1m${key}\u001b[0m: ${value}`)
	}
	console.log("\n\u001b[1mr\u001b[0m rerun   \u001b[1mq\u001b[0m quit")
}

let state = await prove()
if (process.argv.includes("--ci") || !process.stdin.isTTY) {
	console.log(JSON.stringify(state))
	process.exit(state.verdict === "compatible" ? 0 : 1)
}

render(state)
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", async (bytes) => {
	const key = bytes.toString()
	if (key === "q" || key === "\u0003") process.exit(0)
	if (key === "r") {
		state = await prove()
		render(state)
	}
})
