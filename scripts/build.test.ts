import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeAll, expect, test } from "bun:test"

import {
	admitDependencyClosure,
	BundleValidationError,
	buildHelloWorldRuntime,
	buildWorkspaceBundles,
	bundleWorkspaceSkill,
	collectModuleSpecifiers,
	DependencyAdmissionError,
	renderBundleInventoryProjection,
	renderThirdPartyNotices,
	validateBunOnlyPayload,
	validateBundleClosure,
	validateBundleText,
} from "./build"
import { copyPluginPayload } from "./plugin-files"

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const temporaryRoots: string[] = []

beforeAll(() => {
	const install = Bun.spawnSync({
		cmd: [process.execPath, "install", "--frozen-lockfile"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (install.exitCode !== 0) throw new Error(install.stderr.toString())
})

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

function fixtureWorkspace(source: string, packageJson?: Record<string, unknown>): {
	fixtureRoot: string
	workspace: string
	staging: string
} {
	const fixtureRoot = temporaryDirectory("bundle-fixture-")
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(workspaceDirectory, "src"), { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify(
			packageJson ?? { name: "fixture-skill", private: true, type: "module", main: "src/main.js" },
			null,
			2,
		)}\n`,
	)
	writeFileSync(join(workspaceDirectory, "src", "main.js"), source)
	return {
		fixtureRoot,
		workspace: "packages/fixture-skill",
		staging: join(fixtureRoot, "staging"),
	}
}

async function expectBundleRejection(
	fixture: ReturnType<typeof fixtureWorkspace>,
	code: string,
	pattern: RegExp,
): Promise<void> {
	await expect(
		bundleWorkspaceSkill(fixture.fixtureRoot, "fixture-skill", fixture.workspace, fixture.staging),
	).rejects.toThrow(pattern)
	try {
		await bundleWorkspaceSkill(
			fixture.fixtureRoot,
			"fixture-skill",
			fixture.workspace,
			fixture.staging,
		)
		expect.unreachable("bundleWorkspaceSkill must reject")
	} catch (error) {
		expect(error).toBeInstanceOf(BundleValidationError)
		expect((error as BundleValidationError).code).toBe(code as BundleValidationError["code"])
	}
}

test("collectModuleSpecifiers finds static, side-effect, dynamic, and require specifiers", () => {
	const code = `import a from "node:path";import "bun:test";const b = require('ms');const c = await import("camelcase");export { d } from "./local.js";`
	expect(collectModuleSpecifiers(code)).toEqual([
		"./local.js",
		"bun:test",
		"camelcase",
		"ms",
		"node:path",
	])
})

test("validateBundleText allows node and bun built-ins only", () => {
	validateBundleText("skill-a", `import { join } from "node:path";import fs from "fs";import "bun:sqlite";`)
	expect(() => validateBundleText("skill-a", `const x = require("left-pad");`)).toThrow(
		/bare specifier "left-pad"/,
	)
})

test("validateBundleText rejects a computed dynamic import", () => {
	expect(() => validateBundleText("skill-a", `const target = "x";await import(target);`)).toThrow(
		/computed dynamic import/,
	)
})

test("validateBundleText rejects a computed runtime require", () => {
	expect(() => validateBundleText("skill-a", `const name = "m" + "s";require(name);`)).toThrow(
		/computed runtime require/,
	)
})

test("validateBundleText rejects built-in loader escape hatches", () => {
	expect(() =>
		validateBundleText(
			"skill-a",
			`import { createRequire as load } from "node:module";load(import.meta.url)("ambient-package");`,
		),
	).toThrow(/runtime module-loader escape/)
	expect(() =>
		validateBundleText("skill-a", `process.getBuiltinModule("module").createRequire(import.meta.url);`),
	).toThrow(/runtime module-loader escape/)
})

test("validateBundleText rejects a concatenated require that begins with a string literal", () => {
	expect(() =>
		validateBundleText("skill-a", `const locale = require("./locale/" + name);`),
	).toThrow(/computed runtime require/)
})

test("validateBundleText rejects a member-access runtime require", () => {
	expect(() => validateBundleText("skill-a", `const m = globalThis.require(name);`)).toThrow(
		/computed runtime require/,
	)
})

test("validateBundleText rejects a concatenated dynamic import that begins with a string literal", () => {
	expect(() =>
		validateBundleText("skill-a", `export const load = (name) => import("./chunk/" + name);`),
	).toThrow(/computed dynamic import/)
})

test("dependency admission returns the pure-JavaScript permissive-license closure", () => {
	const dependencies = admitDependencyClosure(root)
	expect(dependencies.map((dependency) => `${dependency.name}@${dependency.version}`)).toEqual([
		"camelcase@8.0.0",
		"kleur@4.1.5",
		"ms@2.1.3",
	])
	for (const dependency of dependencies) {
		expect(["MIT", "ISC"]).toContain(dependency.license)
		expect(dependency.licenseText).toContain("Permission")
	}
})

function admissionFixture(options: {
	packageJson: Record<string, unknown>
	files?: Record<string, string>
}): string {
	const fixtureRoot = temporaryDirectory("admission-fixture-")
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
	)
	const name = options.packageJson.name as string
	const version = options.packageJson.version as string
	writeFileSync(
		join(fixtureRoot, "bun.lock"),
		`${JSON.stringify({
			lockfileVersion: 1,
			workspaces: { "": { name: "fixture-root" } },
			packages: { [name]: [`${name}@${version}`, "", {}, "sha512-fixture"] },
		})}\n`,
	)
	const packageDirectory = join(
		fixtureRoot,
		"node_modules",
		".bun",
		`${name}@${version}`,
		"node_modules",
		name,
	)
	mkdirSync(packageDirectory, { recursive: true })
	writeFileSync(
		join(packageDirectory, "package.json"),
		`${JSON.stringify(options.packageJson, null, 2)}\n`,
	)
	writeFileSync(join(packageDirectory, "LICENSE"), "Permission is hereby granted.\n")
	for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
		writeFileSync(join(packageDirectory, relativePath), contents)
	}
	return fixtureRoot
}

test("dependency admission rejects a lifecycle-dependent package", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "needs-install",
			version: "1.0.0",
			license: "MIT",
			scripts: { postinstall: "node build.js" },
		},
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/lifecycle script "postinstall"/)
	try {
		admitDependencyClosure(fixtureRoot)
	} catch (error) {
		expect((error as DependencyAdmissionError).code).toBe("lifecycle-script")
	}
})

test("dependency admission rejects a native addon artifact", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "native-thing", version: "1.0.0", license: "MIT" },
		files: { "prebuilt.node": "not-a-script-elf" },
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/native artifact/)
})

test("dependency admission rejects undeclared optional native artifacts", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "optional-native",
			version: "1.0.0",
			license: "MIT",
			optionalDependencies: { "optional-native-darwin-arm64": "1.0.0" },
		},
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/optionalDependencies/)
})

test("dependency admission rejects an unresolved peer dependency", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "needs-peer",
			version: "1.0.0",
			license: "MIT",
			peerDependencies: { "missing-peer": "^1.0.0" },
		},
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/unresolved peer "missing-peer"/)
})

test("dependency admission rejects a root manifest declaring trustedDependencies", () => {
	const fixtureRoot = temporaryDirectory("trusted-dependencies-")
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ name: "fixture-root", private: true, trustedDependencies: [] })}\n`,
	)
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/must not declare trustedDependencies/)
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect((error as DependencyAdmissionError).code).toBe("trusted-dependencies")
	}
})

test("dependency admission rejects a missing frozen lockfile", () => {
	const fixtureRoot = temporaryDirectory("missing-lock-")
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ name: "fixture-root", private: true })}\n`,
	)
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/bun\.lock is missing/)
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect((error as DependencyAdmissionError).code).toBe("store-missing")
	}
})

test("dependency admission rejects a locked package absent from the isolated store", () => {
	const fixtureRoot = temporaryDirectory("absent-store-")
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ name: "fixture-root", private: true })}\n`,
	)
	writeFileSync(
		join(fixtureRoot, "bun.lock"),
		`${JSON.stringify({
			lockfileVersion: 1,
			workspaces: { "": { name: "fixture-root" } },
			packages: { "phantom-pkg": ["phantom-pkg@1.0.0", "", {}, "sha512-fixture"] },
		})}\n`,
	)
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(
		/phantom-pkg@1\.0\.0 is not present in the isolated store/,
	)
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect((error as DependencyAdmissionError).code).toBe("store-missing")
	}
})

test("dependency admission rejects a non-permissive license", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "gpl-thing", version: "1.0.0", license: "GPL-3.0-only" },
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/license/)
})

test("third-party notices carry package name, version, license, and text", () => {
	const notices = renderThirdPartyNotices([
		{ name: "ms", version: "2.1.3", license: "MIT", licenseText: "MIT text\n" },
	])
	expect(notices).toContain("## ms@2.1.3 (MIT)")
	expect(notices).toContain("MIT text")
	expect(notices).toContain("Generated from bun.lock")
})

test("a phantom bare import fails with a precise unresolved-import error", async () => {
	const fixture = fixtureWorkspace(`import leftPad from "left-pad";console.log(leftPad("x", 3));`)
	await expectBundleRejection(fixture, "unresolved-import", /unresolved bare import "left-pad"/)
})

test("parent dependency resolution fails with a precise parent-resolution error", async () => {
	const parentRoot = temporaryDirectory("parent-resolution-")
	const parentPackage = join(parentRoot, "node_modules", "leaked-pkg")
	mkdirSync(parentPackage, { recursive: true })
	writeFileSync(
		join(parentPackage, "package.json"),
		`${JSON.stringify({ name: "leaked-pkg", version: "1.0.0", main: "index.js" })}\n`,
	)
	writeFileSync(join(parentPackage, "index.js"), "module.exports = 'leaked'\n")
	const fixtureRoot = join(parentRoot, "repo")
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(workspaceDirectory, "src"), { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({ name: "fixture-skill", type: "module", main: "src/main.js" })}\n`,
	)
	writeFileSync(join(workspaceDirectory, "src", "main.js"), `import leaked from "leaked-pkg";console.log(leaked);`)

	await expectBundleRejection(
		{ fixtureRoot, workspace: "packages/fixture-skill", staging: join(fixtureRoot, "staging") },
		"parent-resolution",
		/resolved outside the repository/,
	)
})

test("a relative import escaping the repository fails with a precise parent-resolution error", async () => {
	const parentRoot = temporaryDirectory("relative-escape-")
	writeFileSync(join(parentRoot, "outside.js"), "export default 'escaped'\n")
	const fixtureRoot = join(parentRoot, "repo")
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(workspaceDirectory, "src"), { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({ name: "fixture-skill", type: "module", main: "src/main.js" })}\n`,
	)
	writeFileSync(
		join(workspaceDirectory, "src", "main.js"),
		`import outside from "../../../../outside.js";console.log(outside);`,
	)

	await expectBundleRejection(
		{ fixtureRoot, workspace: "packages/fixture-skill", staging: join(fixtureRoot, "staging") },
		"parent-resolution",
		/resolved outside the repository/,
	)
})

test("a workspace without an existing main entry fails with a precise missing-entry error", async () => {
	const fixture = fixtureWorkspace(`console.log("unused");`, {
		name: "fixture-skill",
		private: true,
		type: "module",
		main: "src/absent.js",
	})
	await expectBundleRejection(fixture, "missing-entry", /does not declare an existing "main" entry/)
})

test("a main entry escaping the workspace fails with a precise entry-escape error", async () => {
	// Bun.build never routes the entrypoint through the closed-resolution plugin,
	// so a "main" pointing outside the workspace would be bundled as a valid
	// skill without the containment check. Assert it is rejected.
	const parentRoot = temporaryDirectory("entry-escape-")
	writeFileSync(join(parentRoot, "outside.js"), `console.log("escaped entry");\n`)
	const fixtureRoot = join(parentRoot, "repo")
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(workspaceDirectory, { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({ name: "fixture-skill", type: "module", main: "../../../outside.js" })}\n`,
	)

	await expectBundleRejection(
		{ fixtureRoot, workspace: "packages/fixture-skill", staging: join(fixtureRoot, "staging") },
		"entry-escape",
		/resolves outside the workspace/,
	)
})

test("an unparseable entry fails with a precise bundler-failure error", async () => {
	const fixture = fixtureWorkspace(`export const broken = {`)
	await expectBundleRejection(fixture, "bundler-failure", /./)
})

test("a computed dynamic import fails with a precise build error", async () => {
	const fixture = fixtureWorkspace(
		`const target = process.env.TARGET_MODULE;export const load = () => import(target);console.log("loaded");`,
	)
	await expectBundleRejection(fixture, "computed-dynamic-import", /computed dynamic import/)
})

test("an aliased createRequire fails before bundle materialization", async () => {
	const fixture = fixtureWorkspace(
		`import { createRequire as load } from "node:module";const require = load(import.meta.url);console.log(require("ambient-package"));`,
	)
	await expectBundleRejection(fixture, "runtime-loader", /runtime module-loader escape/)
})

test("hello-world uses the same closed bundle validation gate", async () => {
	const fixtureRoot = temporaryDirectory("hello-world-closure-")
	const sourceDirectory = join(fixtureRoot, "runtime", "src")
	mkdirSync(sourceDirectory, { recursive: true })
	writeFileSync(
		join(sourceDirectory, "bun-proof-adapter.ts"),
		`const target = process.env.TARGET_MODULE;await import(target);`,
	)
	await expect(
		buildHelloWorldRuntime(fixtureRoot, join(fixtureRoot, "staging")),
	).rejects.toMatchObject({ code: "computed-dynamic-import" })
})

test("a failed complete build leaves checked payload input unchanged", async () => {
	const fixtureRoot = temporaryDirectory("atomic-build-candidate-")
	mkdirSync(join(fixtureRoot, "runtime", "src"), { recursive: true })
	mkdirSync(join(fixtureRoot, "plugin", "runtime"), { recursive: true })
	writeFileSync(join(fixtureRoot, "package.json"), '{"private":true}\n')
	writeFileSync(join(fixtureRoot, "bun.lock"), '{"lockfileVersion":1,"packages":{}}\n')
	cpSync(join(root, "runtime", "runtime.lock.json"), join(fixtureRoot, "runtime", "runtime.lock.json"))
	cpSync(
		join(root, "runtime", "skill-catalog.json"),
		join(fixtureRoot, "runtime", "skill-catalog.json"),
	)
	writeFileSync(
		join(fixtureRoot, "runtime", "src", "bun-proof-adapter.ts"),
		`const target = process.env.TARGET_MODULE;await import(target);`,
	)
	const protectedOutputs = new Map([
		[join(fixtureRoot, "plugin", "runtime", "hello-world.js"), "old hello\n"],
		[join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json"), "old inventory\n"],
		[join(fixtureRoot, "plugin", "THIRD-PARTY-NOTICES.md"), "old notices\n"],
	])
	for (const [path, contents] of protectedOutputs) writeFileSync(path, contents)

	await expect(buildWorkspaceBundles(fixtureRoot)).rejects.toMatchObject({
		code: "computed-dynamic-import",
	})
	for (const [path, contents] of protectedOutputs) {
		expect(readFileSync(path, "utf8")).toBe(contents)
	}
})

test("a native addon import fails with a precise native-addon error", async () => {
	const fixture = fixtureWorkspace(`const addon = require("./addon.node");console.log(addon);`, {
		name: "fixture-skill",
		private: true,
		main: "src/main.js",
	})
	writeFileSync(join(fixture.fixtureRoot, "packages", "fixture-skill", "src", "addon.node"), "ELF")
	await expectBundleRejection(fixture, "native-addon", /native addon/)
})

test("an undeclared asset fails with a precise unexpected-output error", async () => {
	const fixture = fixtureWorkspace(`import data from "./data.bin";console.log(data);`)
	writeFileSync(
		join(fixture.fixtureRoot, "packages", "fixture-skill", "src", "data.bin"),
		"binary-bytes",
	)
	await expectBundleRejection(fixture, "unexpected-output", /exactly one JavaScript artifact/)
})

function runRepositoryBuild(): {
	bundles: Record<string, { path: string; bytes: number; sha256: string }>
	notices: { path: string; bytes: number; sha256: string }
} {
	const build = Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/build.ts"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (build.exitCode !== 0) throw new Error(build.stderr.toString())
	const inventory = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	)
	return { bundles: inventory.bundles, notices: inventory.notices }
}

test("workspace bundles build, relocate, and execute without workspaces or node_modules", () => {
	const result = runRepositoryBuild()
	expect(Object.keys(result.bundles)).toEqual(["hello-world", "skill-a", "skill-b"])
	validateBundleClosure(root)

	const installedRoot = temporaryDirectory("relocated-plugin-")
	copyPluginPayload(root, installedRoot)
	const environment = { PATH: "/usr/bin:/bin", HOME: installedRoot }

	const skillA = Bun.spawnSync({
		cmd: [process.execPath, join(installedRoot, result.bundles["skill-a"].path)],
		cwd: installedRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(skillA.stderr.toString()).toBe("")
	expect(skillA.exitCode).toBe(0)
	expect(JSON.parse(skillA.stdout.toString())).toEqual({
		skill: "skill-a",
		moduleShape: "esm",
		esmDependency: "skillAOfflineProof",
		cjsDependencyMilliseconds: 7_200_000,
		sideEffects: "none",
	})

	const skillB = Bun.spawnSync({
		cmd: [process.execPath, join(installedRoot, result.bundles["skill-b"].path)],
		cwd: installedRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(skillB.stderr.toString()).toBe("")
	expect(skillB.exitCode).toBe(0)
	const proofB = JSON.parse(skillB.stdout.toString())
	expect(proofB.skill).toBe("skill-b")
	expect(proofB.moduleShape).toBe("cjs")
	expect(proofB.cjsDependencyDuration).toBe("2 hours")
	expect(proofB.conditionalExportDependency).toBe("[32mconditional-export-proof[39m")

	// Relocated bundles never reach back outside the artifact at runtime: the
	// closed-bundle text contract holds for the exact relocated bytes.
	for (const bundle of Object.values(result.bundles)) {
		const contents = readFileSync(join(installedRoot, bundle.path), "utf8")
		expect(() => validateBundleText("relocated", contents)).not.toThrow()
	}
})

function bunPayloadFixture(): string {
	const fixtureRoot = temporaryDirectory("bun-payload-")
	mkdirSync(join(fixtureRoot, "runtime"), { recursive: true })
	cpSync(join(root, "runtime", "runtime.lock.json"), join(fixtureRoot, "runtime", "runtime.lock.json"))
	cpSync(join(root, "runtime", "skill-catalog.json"), join(fixtureRoot, "runtime", "skill-catalog.json"))
	cpSync(join(root, "plugin"), join(fixtureRoot, "plugin"), { recursive: true })
	return fixtureRoot
}

test("Bun-only release admission accepts the complete current payload", () => {
	expect(() => validateBunOnlyPayload(bunPayloadFixture())).not.toThrow()
})

test("Bun-only release admission rejects a legacy runtime surface", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", "runtime", "qjs-legacy"), "legacy\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/legacy runtime surface/)
})

test("Bun-only release admission rejects an orphaned launcher", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", "bin", "orphan"), "#!/bin/sh\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/launcher inventory/)
})

test("repeated builds produce identical bundle, inventory, and notices bytes", () => {
	const first = runRepositoryBuild()
	const firstInventory = readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"))
	const firstNotices = readFileSync(join(root, "plugin", "THIRD-PARTY-NOTICES.md"))
	const firstBundles = Object.fromEntries(
		Object.entries(first.bundles).map(([skillId, bundle]) => [
			skillId,
			readFileSync(join(root, "plugin", bundle.path)),
		]),
	)

	const second = runRepositoryBuild()
	expect(readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"))).toEqual(
		firstInventory,
	)
	expect(readFileSync(join(root, "plugin", "THIRD-PARTY-NOTICES.md"))).toEqual(firstNotices)
	for (const [skillId, bundle] of Object.entries(second.bundles)) {
		expect(readFileSync(join(root, "plugin", bundle.path))).toEqual(firstBundles[skillId])
	}
})

function closureFixture(): string {
	const fixtureRoot = temporaryDirectory("closure-fixture-")
	mkdirSync(join(fixtureRoot, "runtime"), { recursive: true })
	mkdirSync(join(fixtureRoot, "plugin", "runtime"), { recursive: true })
	mkdirSync(join(fixtureRoot, "plugin", "skills", "skill-a"), { recursive: true })
	writeFileSync(
		join(fixtureRoot, "runtime", "runtime.lock.json"),
		readFileSync(join(root, "runtime", "runtime.lock.json")),
	)
	writeFileSync(
		join(fixtureRoot, "runtime", "skill-catalog.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			skills: {
				"skill-a": {
					entry: "runtime/skill-a.js",
					runtimeProfile: "bun",
					workspace: "packages/skill-a",
				},
			},
		})}\n`,
	)
	writeFileSync(join(fixtureRoot, "plugin", "skills", "skill-a", "SKILL.md"), "# skill-a\n")
	const bundleContents = "console.log('bundled');\n"
	const sha256 = new Bun.CryptoHasher("sha256").update(bundleContents).digest("hex")
	const fileName = `skill-a-${sha256.slice(0, 16)}.js`
	writeFileSync(join(fixtureRoot, "plugin", "runtime", fileName), bundleContents)
	const noticesContents = "# Third-Party Notices\n"
	writeFileSync(join(fixtureRoot, "plugin", "THIRD-PARTY-NOTICES.md"), noticesContents)
	writeFileSync(
		join(fixtureRoot, "plugin", "runtime", "bundle-inventory.sh"),
		renderBundleInventoryProjection({
			"skill-a": {
				path: `runtime/${fileName}`,
				bytes: Buffer.byteLength(bundleContents),
				sha256,
			},
		}),
	)
	writeFileSync(
		join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				bundles: {
					"skill-a": {
						path: `runtime/${fileName}`,
						bytes: Buffer.byteLength(bundleContents),
						sha256,
					},
				},
				notices: {
					path: "THIRD-PARTY-NOTICES.md",
					bytes: Buffer.byteLength(noticesContents),
					sha256: new Bun.CryptoHasher("sha256").update(noticesContents).digest("hex"),
				},
			},
			null,
			2,
		)}\n`,
	)
	return fixtureRoot
}

test("bundle closure validation accepts a complete fixture", () => {
	validateBundleClosure(closureFixture())
})

test("bundle closure validation fails on a missing mapping before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	inventory.bundles = {}
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/missing bundle mapping for skill-a/)
})

test("bundle closure validation fails on a stale bundle before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventory = JSON.parse(
		readFileSync(join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	)
	writeFileSync(
		join(fixtureRoot, "plugin", inventory.bundles["skill-a"].path),
		"console.log('tampered');\n",
	)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/stale bundle for skill-a/)
})

test("bundle closure validation fails on an orphaned bundle before packaging", () => {
	const fixtureRoot = closureFixture()
	writeFileSync(
		join(fixtureRoot, "plugin", "runtime", `skill-a-${"0".repeat(16)}.js`),
		"console.log('orphan');\n",
	)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/orphaned bundle/)
})

test("bundle closure validation fails on an orphaned mapping before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	inventory.bundles["skill-z"] = inventory.bundles["skill-a"]
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/orphaned mapping for skill-z/)
})

test("bundle closure validation fails on a traversal bundle path before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	const record = inventory.bundles["skill-a"]
	writeFileSync(join(fixtureRoot, "outside.js"), "console.log('bundled');\n")
	record.path = "../outside.js"
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(
		/invalid bundle path \.\.\/outside\.js for skill-a/,
	)
})

test("bundle closure validation fails on a digest-mismatched bundle name before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	const record = inventory.bundles["skill-a"]
	const mismatchedName = `skill-a-${"0".repeat(16)}.js`
	writeFileSync(
		join(fixtureRoot, "plugin", "runtime", mismatchedName),
		"console.log('bundled');\n",
	)
	record.path = `runtime/${mismatchedName}`
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/invalid bundle path/)
})

test("bundle closure validation fails on a malformed bundle digest before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	inventory.bundles["skill-a"].sha256 = "not-a-digest"
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/invalid bundle digest for skill-a/)
})

test("bundle closure validation fails on a relocated notices path before packaging", () => {
	const fixtureRoot = closureFixture()
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	inventory.notices.path = "../THIRD-PARTY-NOTICES.md"
	writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/invalid notices path/)
})

test("packaging admission fails on a stale bundle before any archive is produced", () => {
	const inventoryPath = join(root, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	const [skillId] = Object.keys(inventory.bundles)
	const bundlePath = join(root, "plugin", inventory.bundles[skillId].path)
	const original = readFileSync(bundlePath)
	try {
		writeFileSync(bundlePath, "console.log('tampered');\n")
		const packaged = Bun.spawnSync({
			cmd: [process.execPath, "run", "scripts/package.ts"],
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		})
		expect(packaged.exitCode).not.toBe(0)
		expect(packaged.stderr.toString()).toContain(`stale bundle for ${skillId}`)
	} finally {
		writeFileSync(bundlePath, original)
	}
})

test("bundle closure validation fails on a stale inventory shell projection", () => {
	const fixtureRoot = closureFixture()
	writeFileSync(
		join(fixtureRoot, "plugin", "runtime", "bundle-inventory.sh"),
		"#!/bin/sh\nruntime_inventory_select_bundle() { return 1; }\n",
	)
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/stale bundle inventory projection/)
})

test("bundle closure validation fails on a missing inventory shell projection", () => {
	const fixtureRoot = closureFixture()
	rmSync(join(fixtureRoot, "plugin", "runtime", "bundle-inventory.sh"))
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/bundle-inventory\.sh is missing/)
})

test("bundle closure validation fails on stale notices before packaging", () => {
	const fixtureRoot = closureFixture()
	writeFileSync(join(fixtureRoot, "plugin", "THIRD-PARTY-NOTICES.md"), "# Tampered\n")
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(/stale third-party notices/)
})
