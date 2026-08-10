import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeAll, expect, test } from "bun:test"

import {
	admitDependencyClosure,
	assertSuccessfulInstall,
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

function fixtureWorkspace(
	source: string,
	packageJson?: Record<string, unknown>,
): {
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
			packageJson ?? {
				name: "fixture-skill",
				private: true,
				type: "module",
				main: "src/main.js",
			},
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
	validateBundleText(
		"skill-a",
		`import { join } from "node:path";import fs from "fs";import "bun:sqlite";const os = __require("node:os");`,
	)
	expect(() => validateBundleText("skill-a", `const x = require("left-pad");`)).toThrow(
		/bare specifier "left-pad"/,
	)
	for (const specifier of ["node:definitely-not-real", "bun:definitely-not-real"]) {
		expect(() => validateBundleText("skill-a", `import value from "${specifier}";`)).toThrow(
			new RegExp(`bare specifier "${specifier}"`),
		)
	}
})

test("validateBundleText rejects a computed dynamic import", () => {
	expect(() => validateBundleText("skill-a", `const target = "x";await import(target);`)).toThrow(
		/computed dynamic import/,
	)
})

test("validateBundleText keeps division after postfix operators executable", () => {
	for (const operator of ["++", "--"]) {
		expect(() =>
			validateBundleText("skill-a", `let x = 1;const value = x${operator} / import(target) / y;`),
		).toThrow(/computed dynamic import/)
	}
})

test("validateBundleText keeps division after a contextual of identifier executable", () => {
	expect(() =>
		validateBundleText(
			"skill-a",
			`function ratio(of, target, y) { return of / import(target) / y; }`,
		),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText masks regex literals after control-flow conditions", () => {
	validateBundleText("skill-a", `if (ok) /require|Function|eval/.test(value);`)
	validateBundleText("skill-a", `if (ok) {} /require|Function|eval/.test(value);`)
	expect(() =>
		validateBundleText("skill-a", `const value = {} / import(target) / y;`),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText keeps division after expression parentheses executable", () => {
	expect(() =>
		validateBundleText("skill-a", `const ratio = (value) / import(target) / y;`),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText does not treat control-keyword member names as conditions", () => {
	for (const memberCall of ["obj.if(ok)", "obj /*a*/ . /*b*/ if(ok)", "this.#if(ok)"]) {
		expect(() =>
			validateBundleText("skill-a", `const ratio = ${memberCall} / import(target) / y;`),
		).toThrow(/computed dynamic import/)
	}
})

test("validateBundleText does not treat regex-prefix member names as keywords", () => {
	expect(() =>
		validateBundleText("skill-a", `const ratio = obj.return / import(target) / y;`),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText masks regex literals after declaration blocks", () => {
	validateBundleText("skill-a", `export function f() { return 1 } /require/.test(value)`)
	validateBundleText("skill-a", `export class C {} /require/.test(value)`)
	expect(() =>
		validateBundleText("skill-a", `const f = function () {}; const ratio = f / import(target) / y;`),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText masks regex literals after other statement blocks", () => {
	validateBundleText(
		"skill-a",
		`try { work() } catch (error) {} finally {} /require/.test(value)`,
	)
	validateBundleText("skill-a", `try { work() } catch {} /require/.test(value)`)
	validateBundleText("skill-a", `if (ok) {} else {} /require/.test(value)`)
	validateBundleText("skill-a", `do {} while (ok) /require/.test(value)`)
	validateBundleText("skill-a", `{ work() } /require/.test(value)`)
	expect(() =>
		validateBundleText("skill-a", `const value = {} / import(target) / y;`),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText distinguishes labeled blocks from object properties", () => {
	validateBundleText("skill-a", `label: {} /require/.test(value)`)
	expect(() =>
		validateBundleText(
			"skill-a",
			`const value = { nested: {} / import(target) / y };`,
		),
	).toThrow(/computed dynamic import/)
})

test("validateBundleText keeps division after direct-statement keyword property values executable", () => {
	for (const property of ["try", "catch", "do", "else", "finally"]) {
		expect(() =>
			validateBundleText("skill-a", `const value = { ${property}: {} / __require(target) / 1 };`),
		).toThrow(/computed runtime require/)
	}
})

test("validateBundleText rejects a computed runtime require", () => {
	expect(() => validateBundleText("skill-a", `const name = "m" + "s";require(name);`)).toThrow(
		/computed runtime require/,
	)
})

test("validateBundleText ignores loader words outside executable call sites", () => {
	validateBundleText(
		"skill-a",
		`const text = "require eval Function";
		// require(commentedTarget)
		const pattern = /require\\(eval|Function/;
		const object = { require: true, eval: true, Function: true };
		console.log(object.value, text, pattern);`,
	)
})

test("validateBundleText inspects loader calls inside template expressions", () => {
	expect(() =>
		validateBundleText("skill-a", "const text = `value: ${require(target)}`;"),
	).toThrow(/computed runtime require/)
})

test("validateBundleText rejects indirect runtime require calls", () => {
	for (const code of [
		`__require.call(null, target);`,
		`require.apply(null, args);`,
		`require["bind"](null)(target);`,
		`const load = __require;load(target);`,
	]) {
		expect(() => validateBundleText("skill-a", code)).toThrow(/computed runtime require/)
	}
})

test("validateBundleText rejects built-in loader escape hatches", () => {
	expect(() =>
		validateBundleText(
			"skill-a",
			`import { createRequire as load } from "node:module";load(import.meta.url)("ambient-package");`,
		),
	).toThrow(/runtime module-loader escape/)
	expect(() =>
		validateBundleText(
			"skill-a",
			`process.getBuiltinModule("module").createRequire(import.meta.url);`,
		),
	).toThrow(/runtime module-loader escape/)
	expect(() =>
		validateBundleText(
			"skill-a",
			`const { require: load } = import.meta;load(process.env.TARGET_MODULE);`,
		),
	).toThrow(/destructured runtime module-loader escape/)
	for (const code of [
		`const { ["require"]: load } = import.meta;load(process.env.TARGET_MODULE);`,
		`const { url, ["require"]: load } = import.meta;load(process.env.TARGET_MODULE);`,
		`const keys = ["require"];const { [keys[0]]: load } = import.meta;load(process.env.TARGET_MODULE);`,
		`const { ["requ\\u0069re"]: load } = globalThis;load(process.env.TARGET_MODULE);`,
		`const { ["__require"]: load } = import.meta;load(process.env.TARGET_MODULE);`,
		`const { ["__require"]: load } = globalThis;load(process.env.TARGET_MODULE);`,
	]) {
		expect(() => validateBundleText("skill-a", code)).toThrow(
			/computed-key destructured ambient runtime escape/,
		)
	}
	for (const specifier of ["module", "node:module"]) {
		expect(() =>
			validateBundleText(
				"skill-a",
				`import * as moduleNamespace from "${specifier}";const key = process.env.KEY;moduleNamespace[key](import.meta.url);`,
			),
		).toThrow(/runtime escape built-in/)
	}
})

test("validateBundleText allows ordinary methods named require", () => {
	validateBundleText(
		"skill-a",
		`const registry = { require(name) { return this[name] } }; class Catalog { require(callback = () => "ok") { return callback() } }; registry.require("x"); new Catalog().require()`,
	)
})

test("validateBundleText rejects runtime code generation", () => {
	for (const code of [
		`const load = new Function("target", "return im" + "port(target)");`,
		`const load = Function("return 1");`,
		`const load = Function.call(null, "target", "return im" + "port(target)");`,
		`const load = Function.apply(null, ["target", "return im" + "port(target)"]);`,
		`const load = Function.bind(null, "target")("return im" + "port(target)");`,
		`const Factory = Function;const load = Factory("return 1");`,
		`const load = (0, Function)("return 1");`,
		`const load = eval("target => im" + "port(target)");`,
	]) {
		expect(() => validateBundleText("skill-a", code)).toThrow(/runtime code generation/)
	}
})

test("validateBundleText rejects direct and aliased constructor-based runtime code generation", () => {
	for (const code of [
		`(() => {}).constructor("p", "return import(p)")`,
		`const C = (() => {}).constructor;const load = C("p", "return import(p)");load(target)`,
	]) {
		expect(() => validateBundleText("skill-a", code)).toThrow(/runtime code generation/)
	}
})

test("validateBundleText allows non-invoked Function references", () => {
	validateBundleText(
		"skill-a",
		`const call = Function.prototype.call;const isFunction = value instanceof Function;console.log(call, isFunction);`,
	)
})

test("validateBundleText rejects node:vm runtime code generation", () => {
	expect(() =>
		validateBundleText(
			"skill-a",
			`import vm from "node:vm";vm.runInThisContext("p => import(p)")`,
		),
	).toThrow(/runtime escape built-in/)
})

test("validateBundleText rejects a concatenated require that begins with a string literal", () => {
	expect(() =>
		validateBundleText("skill-a", `const locale = require("./locale/" + name);`),
	).toThrow(/computed runtime require/)
})

test("validateBundleText rejects a member-access runtime require", () => {
	for (const code of [
		`const m = globalThis.require(name);`,
		`const fs = globalThis.require("node:fs");`,
		`const fs = import.meta.require("node:fs");`,
		`const fs = globalThis["require"]("node:fs");`,
		`const fs = import.meta["require"]("node:fs");`,
		`const key = "require";const fs = globalThis[key]("node:fs");`,
		`const key = ["require"];const fs = globalThis[key[0]]("node:fs");`,
		`const key = "require";const fs = import.meta[key]?.("node:fs");`,
		`const key = "require";const fs = globalThis?.[key]?.("node:fs");`,
		`const key = process.env.KEY;const load = import.meta[key];load(process.env.TARGET);`,
		`const key = process.env.KEY;const load = globalThis[key];load(process.env.TARGET);`,
		`const meta = import.meta;const key = process.env.KEY;meta[key](process.env.TARGET);`,
		`const root = globalThis;const key = process.env.KEY;root[key](process.env.TARGET);`,
	]) {
		expect(() => validateBundleText("skill-a", code)).toThrow(/ambient runtime/)
	}
})

test("validateBundleText allows ordinary ambient dot references", () => {
	validateBundleText("skill-a", `globalThis.console.log(import.meta.url);`)
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
	extraLockedPackages?: Record<string, unknown[]>
	workspaceDevDependencies?: Record<string, string>
	omitStore?: boolean
}): string {
	const fixtureRoot = temporaryDirectory("admission-fixture-")
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
	)
	const name = options.packageJson.name as string
	const version = options.packageJson.version as string
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(fixtureRoot, "runtime"), { recursive: true })
	mkdirSync(workspaceDirectory, { recursive: true })
	cpSync(
		join(root, "runtime", "runtime.lock.json"),
		join(fixtureRoot, "runtime", "runtime.lock.json"),
	)
	writeFileSync(
		join(fixtureRoot, "runtime", "skill-catalog.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			skills: {
				"fixture-skill": {
					entry: "runtime/fixture-skill.js",
					runtimeProfile: "bun",
					workspace: "packages/fixture-skill",
				},
			},
		})}\n`,
	)
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({
			name: "fixture-skill",
			private: true,
			dependencies: { [name]: version },
			devDependencies: options.workspaceDevDependencies,
		})}\n`,
	)
	writeFileSync(
		join(fixtureRoot, "bun.lock"),
		`${JSON.stringify({
			lockfileVersion: 1,
			workspaces: {
				"": { name: "fixture-root" },
				"packages/fixture-skill": {
					name: "fixture-skill",
					dependencies: { [name]: version },
					devDependencies: options.workspaceDevDependencies,
				},
			},
			packages: {
				[name]: [`${name}@${version}`, "", {}, "sha512-fixture"],
				"fixture-skill": ["fixture-skill@workspace:packages/fixture-skill"],
				...options.extraLockedPackages,
			},
		})}\n`,
	)
	if (options.omitStore) return fixtureRoot
	writeFixturePackageStore(fixtureRoot, options.packageJson, options.files)
	return fixtureRoot
}

function writeFixturePackageStore(
	fixtureRoot: string,
	packageJson: Record<string, unknown>,
	files: Record<string, string> = {},
): void {
	const name = packageJson.name as string
	const version = packageJson.version as string
	const packageDirectory = join(
		fixtureRoot,
		"node_modules",
		".bun",
		`${name}@${version}`,
		"node_modules",
		name,
	)
	mkdirSync(packageDirectory, { recursive: true })
	writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`)
	writeFileSync(join(packageDirectory, "LICENSE"), "Permission is hereby granted.\n")
	for (const [relativePath, contents] of Object.entries(files)) {
		writeFileSync(join(packageDirectory, relativePath), contents)
	}
}

test("dependency admission parses JSONC comments, trailing commas, and quoted comma sequences", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "jsonc-package", version: "1.0.0", license: "MIT" },
	})
	writeFileSync(
		join(fixtureRoot, "bun.lock"),
		`{
			// Bun lockfiles are JSONC.
			"lockfileVersion": 1,
			"note": "quoted,} and quoted,] stay intact",
			"workspaces": {
				"": { "name": "fixture-root", },
				"packages/fixture-skill": {
					"name": "fixture-skill",
					"dependencies": { "jsonc-package": "1.0.0", },
				},
			},
			"packages": {
				"jsonc-package": ["jsonc-package@1.0.0", "", {}, "sha512-fixture"],
				"fixture-skill": ["fixture-skill@workspace:packages/fixture-skill"],
			},
		}\n`,
	)
	expect(admitDependencyClosure(fixtureRoot).map((dependency) => dependency.name)).toEqual([
		"jsonc-package",
	])
})

test("dependency admission reports malformed JSONC as a typed error", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "broken-lock", version: "1.0.0", license: "MIT" },
	})
	writeFileSync(join(fixtureRoot, "bun.lock"), '{ "packages": { "broken": [ } }\n')
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect(error).toBeInstanceOf(DependencyAdmissionError)
		expect((error as DependencyAdmissionError).code).toBe("lock-invalid")
	}
})

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

test("dependency admission rejects a reachable peer outside the required range", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "needs-peer",
			version: "1.0.0",
			license: "MIT",
			peerDependencies: { "runtime-peer": "^18.0.0" },
		},
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.workspaces["packages/fixture-skill"].dependencies["runtime-peer"] = "17.0.0"
	lock.packages["runtime-peer"] = ["runtime-peer@17.0.0", "", {}, "sha512-peer"]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	writeFixturePackageStore(fixtureRoot, {
		name: "runtime-peer",
		version: "17.0.0",
		license: "MIT",
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(
		/needs-peer@1\.0\.0 has unresolved peer "runtime-peer" for \^18\.0\.0/,
	)
})

test("dependency admission accepts a peer selected in the same workspace graph", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "needs-peer",
			version: "1.0.0",
			license: "MIT",
			peerDependencies: { "runtime-peer": "^18.0.0" },
		},
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.workspaces["packages/fixture-skill"].dependencies["runtime-peer"] = "18.2.0"
	lock.packages["runtime-peer"] = ["runtime-peer@18.2.0", "", {}, "sha512-peer"]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	writeFixturePackageStore(fixtureRoot, {
		name: "runtime-peer",
		version: "18.2.0",
		license: "MIT",
	})
	expect(admitDependencyClosure(fixtureRoot).map(({ name }) => name)).toEqual([
		"needs-peer",
		"runtime-peer",
	])
})

test("workspace peer imports resolve through the admitted graph and validate the selected version", async () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "runtime-peer",
			version: "18.2.0",
			license: "MIT",
			type: "module",
			main: "index.js",
		},
		files: { "index.js": `export default "workspace-peer-proof";\n` },
	})
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(workspaceDirectory, "src"), { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({
			name: "fixture-skill",
			private: true,
			type: "module",
			main: "src/main.js",
			peerDependencies: { "runtime-peer": "^18.0.0" },
		})}\n`,
	)
	writeFileSync(
		join(workspaceDirectory, "src", "main.js"),
		`import peer from "runtime-peer";console.log(peer);`,
	)
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.workspaces["packages/fixture-skill"].dependencies = {}
	lock.workspaces["packages/fixture-skill"].peerDependencies = {
		"runtime-peer": "^18.0.0",
	}
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	const peerDirectory = join(
		fixtureRoot,
		"node_modules",
		".bun",
		"runtime-peer@18.2.0",
		"node_modules",
		"runtime-peer",
	)
	symlinkSync(peerDirectory, join(fixtureRoot, "node_modules", "runtime-peer"), "dir")

	const artifact = await bundleWorkspaceSkill(
		fixtureRoot,
		"fixture-skill",
		"packages/fixture-skill",
		join(fixtureRoot, "staging"),
	)
	expect(new TextDecoder().decode(artifact.contents)).toContain("workspace-peer-proof")

	lock.workspaces["packages/fixture-skill"].peerDependencies["runtime-peer"] = "^19.0.0"
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	await expect(
		bundleWorkspaceSkill(
			fixtureRoot,
			"fixture-skill",
			"packages/fixture-skill",
			join(fixtureRoot, "invalid-peer-staging"),
		),
	).rejects.toMatchObject({ code: "lock-invalid" })
})

test("semver workspace peers resolve through the referenced workspace version", async () => {
	const fixture = fixtureWorkspace(`import shared from "shared";console.log(shared);`, {
		name: "fixture-skill",
		private: true,
		type: "module",
		main: "src/main.js",
		peerDependencies: { shared: "^1.0.0" },
	})
	const sharedWorkspace = join(fixture.fixtureRoot, "packages", "shared")
	mkdirSync(sharedWorkspace, { recursive: true })
	writeFileSync(
		join(sharedWorkspace, "package.json"),
		`${JSON.stringify({
			name: "shared",
			version: "1.2.0",
			type: "module",
			main: "index.js",
		})}\n`,
	)
	writeFileSync(join(sharedWorkspace, "index.js"), `export default "workspace-range-proof";\n`)
	writeFileSync(
		join(fixture.fixtureRoot, "package.json"),
		'{"name":"fixture-root","private":true,"workspaces":["packages/*"]}\n',
	)
	const lockPath = join(fixture.fixtureRoot, "bun.lock")
	const lock = {
		lockfileVersion: 1,
		workspaces: {
			"": { name: "fixture-root" },
			"packages/fixture-skill": {
				name: "fixture-skill",
				peerDependencies: { shared: "^1.0.0" },
			},
			"packages/shared": { name: "shared", version: "1.2.0" },
		},
		packages: {
			"fixture-skill": ["fixture-skill@workspace:packages/fixture-skill"],
			shared: ["shared@workspace:packages/shared"],
		},
	}
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	mkdirSync(join(fixture.fixtureRoot, "node_modules"), { recursive: true })
	symlinkSync(sharedWorkspace, join(fixture.fixtureRoot, "node_modules", "shared"), "dir")

	const artifact = await bundleWorkspaceSkill(
		fixture.fixtureRoot,
		"fixture-skill",
		fixture.workspace,
		fixture.staging,
	)
	expect(new TextDecoder().decode(artifact.contents)).toContain("workspace-range-proof")

	lock.workspaces["packages/shared"].version = "2.0.0"
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	await expect(
		bundleWorkspaceSkill(
			fixture.fixtureRoot,
			"fixture-skill",
			fixture.workspace,
			join(fixture.fixtureRoot, "invalid-workspace-peer-staging"),
		),
	).rejects.toMatchObject({ code: "lock-invalid" })
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

test("dependency admission rejects trustedDependencies in a workspace manifest", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "workspace-trust", version: "1.0.0", license: "MIT" },
	})
	writeFileSync(
		join(fixtureRoot, "packages", "fixture-skill", "package.json"),
		'{"name":"fixture-skill","trustedDependencies":[]}\n',
	)
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect(error).toBeInstanceOf(DependencyAdmissionError)
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
	const fixtureRoot = admissionFixture({
		packageJson: { name: "phantom-pkg", version: "1.0.0", license: "MIT" },
		omitStore: true,
	})
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

test("dependency admission excludes dev-only locked packages from the catalog closure", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
		workspaceDevDependencies: { "dev-only-package": "9.0.0" },
		extraLockedPackages: {
			"dev-only-package": ["dev-only-package@9.0.0", "", {}, "sha512-dev-only"],
		},
	})
	expect(admitDependencyClosure(fixtureRoot).map(({ name }) => name)).toEqual(["runtime-package"])
})

test("dependency admission follows the bounded production dependency graph", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.packages["runtime-package"][2] = {
		dependencies: { "runtime-child": "^2.0.0" },
	}
	lock.packages["runtime-child"] = ["runtime-child@2.3.1", "", {}, "sha512-runtime-child"]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	writeFixturePackageStore(fixtureRoot, {
		name: "runtime-child",
		version: "2.3.1",
		license: "ISC",
	})
	expect(admitDependencyClosure(fixtureRoot).map(({ name }) => name)).toEqual([
		"runtime-child",
		"runtime-package",
	])
})

test("dependency admission resolves versioned and versionless npm aliases through their lock key", () => {
	for (const [realName, requested] of [
		["real-package", "npm:real-package@1.2.3"],
		["real-package", "npm:real-package"],
		["@scope/real-package", "npm:@scope/real-package"],
	] as const) {
		const fixtureRoot = admissionFixture({
			packageJson: { name: realName, version: "1.2.3", license: "MIT" },
		})
		const workspaceManifestPath = join(
			fixtureRoot,
			"packages",
			"fixture-skill",
			"package.json",
		)
		const workspaceManifest = JSON.parse(readFileSync(workspaceManifestPath, "utf8"))
		workspaceManifest.dependencies = { alias: requested }
		writeFileSync(workspaceManifestPath, `${JSON.stringify(workspaceManifest, null, 2)}\n`)
		const lockPath = join(fixtureRoot, "bun.lock")
		const lock = JSON.parse(readFileSync(lockPath, "utf8"))
		lock.workspaces["packages/fixture-skill"].dependencies = { alias: requested }
		lock.packages.alias = lock.packages[realName]
		delete lock.packages[realName]
		writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)

		expect(admitDependencyClosure(fixtureRoot).map(({ name }) => name)).toEqual([realName])
	}
})

test("workspace peers cannot select a different nested package than the workspace dependency", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.workspaces["packages/fixture-skill"].dependencies["runtime-peer"] = "17.0.0"
	lock.workspaces["packages/fixture-skill"].peerDependencies = {
		"runtime-peer": "^18.0.0",
	}
	lock.packages["runtime-peer"] = ["runtime-peer@17.0.0", "", {}, "sha512-peer-17"]
	lock.packages["other/runtime-peer"] = [
		"runtime-peer@18.2.0",
		"",
		{},
		"sha512-peer-18",
	]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)

	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(
		/bun\.lock selection runtime-peer does not satisfy runtime-peer@\^18\.0\.0/,
	)
})

test("dependency admission resolves a workspace protocol dependency by package identity", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const sharedWorkspace = join(fixtureRoot, "packages", "shared-runtime")
	mkdirSync(sharedWorkspace, { recursive: true })
	writeFileSync(
		join(sharedWorkspace, "package.json"),
		'{"name":"shared-runtime","private":true,"type":"module"}\n',
	)
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.workspaces["packages/fixture-skill"].dependencies["shared-runtime"] = "workspace:*"
	lock.workspaces["packages/shared-runtime"] = { name: "shared-runtime" }
	lock.packages["shared-runtime"] = [
		"shared-runtime@workspace:packages/shared-runtime",
	]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	expect(admitDependencyClosure(fixtureRoot).map(({ name }) => name)).toEqual([
		"runtime-package",
	])
})

test("dependency admission follows the parent-specific lock selection", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.packages["runtime-package"][2] = {
		dependencies: { "runtime-child": "^2.0.0" },
	}
	lock.packages["runtime-child"] = ["runtime-child@3.0.0", "", {}, "sha512-hoisted"]
	lock.packages["runtime-package/runtime-child"] = ["runtime-child@2.3.1", "", {}, "sha512-nested"]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	for (const version of ["2.3.1", "3.0.0"]) {
		writeFixturePackageStore(fixtureRoot, {
			name: "runtime-child",
			version,
			license: "ISC",
		})
	}
	expect(
		admitDependencyClosure(fixtureRoot).map(({ name, version }) => `${name}@${version}`),
	).toEqual(["runtime-child@2.3.1", "runtime-package@1.0.0"])
})

test("dependency admission rejects a transitive selection outside its requested range", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.packages["runtime-package"][2] = {
		dependencies: { "runtime-child": "^2.0.0" },
	}
	lock.packages["runtime-child"] = ["runtime-child@3.0.0", "", {}, "sha512-wrong-range"]
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(
		/bun\.lock cannot resolve runtime-child@\^2\.0\.0 from runtime-package/,
	)
})

test("dependency admission rejects a bare-key package at the wrong locked version", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
	})
	const lockPath = join(fixtureRoot, "bun.lock")
	const lock = JSON.parse(readFileSync(lockPath, "utf8"))
	lock.packages["runtime-package"][0] = "runtime-package@2.0.0"
	writeFileSync(lockPath, `${JSON.stringify(lock)}\n`)
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect(error).toBeInstanceOf(DependencyAdmissionError)
		expect((error as DependencyAdmissionError).code).toBe("lock-invalid")
	}
})

test("dependency admission rejects malformed lock identities with a typed error", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "runtime-package", version: "1.0.0", license: "MIT" },
		extraLockedPackages: { malformed: ["missing-version-separator"] },
	})
	try {
		admitDependencyClosure(fixtureRoot)
		expect.unreachable("admitDependencyClosure must reject")
	} catch (error) {
		expect(error).toBeInstanceOf(DependencyAdmissionError)
		expect((error as DependencyAdmissionError).code).toBe("lock-invalid")
	}
})

test("dependency admission rejects a non-permissive license", () => {
	const fixtureRoot = admissionFixture({
		packageJson: {
			name: "gpl-thing",
			version: "1.0.0",
			license: "GPL-3.0-only",
		},
	})
	expect(() => admitDependencyClosure(fixtureRoot)).toThrow(/license/)
})

test("dependency admission selects license files in code-unit order", () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "sorted-license", version: "1.0.0", license: "MIT" },
		files: { LICENCE: "Deterministic licence text.\n" },
	})
	expect(admitDependencyClosure(fixtureRoot)[0].licenseText).toBe("Deterministic licence text.\n")
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

test("declared package import aliases remain inside the workspace closure", async () => {
	const fixture = fixtureWorkspace(
		`import exact from "#exact";import wildcard from "#lib/value";console.log(exact, wildcard);`,
		{
			name: "fixture-skill",
			private: true,
			type: "module",
			main: "src/main.js",
			imports: {
				"#exact": "./src/exact.js",
				"#lib/*": "./src/lib/*.js",
			},
		},
	)
	const workspaceRoot = join(fixture.fixtureRoot, fixture.workspace)
	mkdirSync(join(workspaceRoot, "src", "lib"), { recursive: true })
	writeFileSync(join(workspaceRoot, "src", "exact.js"), `export default "exact";\n`)
	writeFileSync(join(workspaceRoot, "src", "lib", "value.js"), `export default "wildcard";\n`)

	const artifact = await bundleWorkspaceSkill(
		fixture.fixtureRoot,
		"fixture-skill",
		fixture.workspace,
		fixture.staging,
	)
	const bundle = new TextDecoder().decode(artifact.contents)
	expect(bundle).toContain('var exact_default = "exact";')
	expect(bundle).toContain('var value_default = "wildcard";')
	expect(bundle).not.toContain('from "#')
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
		`${JSON.stringify({
			name: "fixture-skill",
			type: "module",
			main: "src/main.js",
			dependencies: { "leaked-pkg": "1.0.0" },
		})}\n`,
	)
	writeFileSync(
		join(workspaceDirectory, "src", "main.js"),
		`import leaked from "leaked-pkg";console.log(leaked);`,
	)

	await expectBundleRejection(
		{
			fixtureRoot,
			workspace: "packages/fixture-skill",
			staging: join(fixtureRoot, "staging"),
		},
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
		{
			fixtureRoot,
			workspace: "packages/fixture-skill",
			staging: join(fixtureRoot, "staging"),
		},
		"parent-resolution",
		/resolved outside the repository/,
	)
})

test("a non-JavaScript asset outside the production graph is rejected", async () => {
	const fixture = fixtureWorkspace(
		`import text from "../../../outside.txt";console.log(text);`,
	)
	writeFileSync(join(fixture.fixtureRoot, "outside.txt"), "build-host content\n")
	await expectBundleRejection(
		fixture,
		"unadmitted-import",
		/module is outside the workspace production dependency graph/,
	)
})

test("an admitted workspace text asset keeps Bun's built-in loader behavior", async () => {
	const fixture = fixtureWorkspace(`import text from "./message.txt";console.log(text);`)
	writeFileSync(
		join(fixture.fixtureRoot, "packages", "fixture-skill", "src", "message.txt"),
		"allowed workspace text\n",
	)
	const artifact = await bundleWorkspaceSkill(
		fixture.fixtureRoot,
		"fixture-skill",
		fixture.workspace,
		fixture.staging,
	)
	expect(new TextDecoder().decode(artifact.contents)).toContain("allowed workspace text")
})

test("a bare non-JavaScript asset resolving outside the repository is rejected", async () => {
	const fixtureRoot = admissionFixture({
		packageJson: { name: "asset-package", version: "1.0.0", license: "MIT" },
	})
	const workspaceDirectory = join(fixtureRoot, "packages", "fixture-skill")
	mkdirSync(join(workspaceDirectory, "src"), { recursive: true })
	writeFileSync(
		join(workspaceDirectory, "package.json"),
		`${JSON.stringify({
			name: "fixture-skill",
			private: true,
			type: "module",
			main: "src/main.js",
			dependencies: { "asset-package": "1.0.0" },
		})}\n`,
	)
	writeFileSync(
		join(workspaceDirectory, "src", "main.js"),
		`import text from "asset-package/asset.txt";console.log(text);`,
	)
	const outsideRoot = temporaryDirectory("bare-asset-escape-")
	const outsideAsset = join(outsideRoot, "asset.txt")
	writeFileSync(outsideAsset, "build-host content\n")
	const packageAsset = join(
		fixtureRoot,
		"node_modules",
		".bun",
		"asset-package@1.0.0",
		"node_modules",
		"asset-package",
		"asset.txt",
	)
	symlinkSync(outsideAsset, packageAsset)
	symlinkSync(
		dirname(packageAsset),
		join(fixtureRoot, "node_modules", "asset-package"),
		"dir",
	)

	await expectBundleRejection(
		{
			fixtureRoot,
			workspace: "packages/fixture-skill",
			staging: join(fixtureRoot, "staging"),
		},
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

test("a missing or invalid workspace manifest fails with a typed missing-entry error", async () => {
	for (const manifest of [undefined, "{ invalid json\n"]) {
		const fixture = fixtureWorkspace(`console.log("unused");`)
		const manifestPath = join(fixture.fixtureRoot, "packages", "fixture-skill", "package.json")
		if (manifest === undefined) rmSync(manifestPath)
		else writeFileSync(manifestPath, manifest)
		await expectBundleRejection(
			fixture,
			"missing-entry",
			/package\.json is missing, unreadable, or invalid/,
		)
	}
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
		{
			fixtureRoot,
			workspace: "packages/fixture-skill",
			staging: join(fixtureRoot, "staging"),
		},
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

test("runtime code generation fails before bundle materialization", async () => {
	const fixture = fixtureWorkspace(
		`const C = (() => {}).constructor;const load = C("target", "return im" + "port(target)");console.log(load);`,
	)
	await expectBundleRejection(fixture, "dynamic-code-generation", /runtime code generation/)
})

test("runtime escape built-ins fail before bundle materialization", async () => {
	const fixtures = [
		[
			fixtureWorkspace(
				`import vm from "node:vm";console.log(vm.runInThisContext("p => import(p)"));`,
			),
			"dynamic-code-generation",
		],
		[
			fixtureWorkspace(
				`import * as M from "node:module";const key = process.env.KEY;console.log(M[key](import.meta.url));`,
			),
			"runtime-loader",
		],
	] as const
	for (const [fixture, code] of fixtures) {
		await expectBundleRejection(fixture, code, /runtime escape built-in/)
	}
})

test("an indirect runtime require fails before bundle materialization", async () => {
	const fixture = fixtureWorkspace(
		`const target = process.env.TARGET_MODULE;console.log(require.call(null, target));`,
	)
	await expectBundleRejection(fixture, "computed-require", /computed runtime require/)
})

test("an aliased runtime require fails before bundle materialization", async () => {
	const fixture = fixtureWorkspace(
		`const load = require;const target = process.env.TARGET_MODULE;console.log(load(target));`,
	)
	await expectBundleRejection(fixture, "computed-require", /computed runtime require/)
})

test("an aliased createRequire fails before bundle materialization", async () => {
	const fixture = fixtureWorkspace(
		`import { createRequire as load } from "node:module";const require = load(import.meta.url);console.log(require("ambient-package"));`,
	)
	await expectBundleRejection(fixture, "runtime-loader", /runtime module-loader escape/)
})

test("a dev-only package import fails the workspace production graph", async () => {
	const fixture = fixtureWorkspace(`import value from "dev-only";console.log(value);`, {
		name: "fixture-skill",
		private: true,
		type: "module",
		main: "src/main.js",
		devDependencies: { "dev-only": "1.0.0" },
	})
	writeFileSync(
		join(fixture.fixtureRoot, "package.json"),
		'{"name":"fixture-root","private":true,"workspaces":["packages/*"]}\n',
	)
	writeFileSync(
		join(fixture.fixtureRoot, "bun.lock"),
		`${JSON.stringify({
			lockfileVersion: 1,
			workspaces: {
				"": { name: "fixture-root" },
				"packages/fixture-skill": {
					name: "fixture-skill",
					devDependencies: { "dev-only": "1.0.0" },
				},
			},
			packages: {
				"dev-only": ["dev-only@1.0.0", "", {}, "sha512-dev-only"],
				"fixture-skill": ["fixture-skill@workspace:packages/fixture-skill"],
			},
		})}\n`,
	)
	const devOnlyDirectory = join(fixture.fixtureRoot, "node_modules", "dev-only")
	mkdirSync(devOnlyDirectory, { recursive: true })
	writeFileSync(
		join(devOnlyDirectory, "package.json"),
		'{"name":"dev-only","version":"1.0.0","main":"index.js"}\n',
	)
	writeFileSync(join(devOnlyDirectory, "index.js"), "export default 'dev-only';\n")
	await expectBundleRejection(
		fixture,
		"unadmitted-import",
		/bare import "dev-only" is not declared/,
	)
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
	cpSync(
		join(root, "runtime", "runtime.lock.json"),
		join(fixtureRoot, "runtime", "runtime.lock.json"),
	)
	writeFileSync(
		join(fixtureRoot, "runtime", "skill-catalog.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			skills: {
				"hello-world": {
					entry: "runtime/hello-world.js",
					runtimeProfile: "bun",
				},
			},
		})}\n`,
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

test("install admission rejects signal and nonzero exits", () => {
	expect(() => assertSuccessfulInstall({ exitCode: null, signalCode: "SIGTERM" })).toThrow(
		/terminated by signal SIGTERM/,
	)
	expect(() => assertSuccessfulInstall({ exitCode: 17 })).toThrow(/exited with code 17/)
	expect(() => assertSuccessfulInstall({ exitCode: 0 })).not.toThrow()
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
	const outputLines = build.stdout.toString().trim().split("\n")
	expect(outputLines).toHaveLength(1)
	const report = JSON.parse(outputLines[0])
	expect(report.helloWorldRuntime).toBe(join(root, "plugin", "runtime", "hello-world.js"))
	const inventory = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	)
	expect(report.bundles).toEqual(inventory.bundles)
	return { bundles: inventory.bundles, notices: inventory.notices }
}

test("workspace bundles build, relocate, and execute without hooks, workspaces, or node_modules", () => {
	const result = runRepositoryBuild()
	expect(Object.keys(result.bundles)).toEqual(["hello-world", "skill-a", "skill-b"])
	validateBundleClosure(root)

	const installedRoot = temporaryDirectory("relocated-plugin-")
	copyPluginPayload(root, installedRoot)
	rmSync(join(installedRoot, "hooks"), { recursive: true })
	expect(readFileSync(join(installedRoot, "skills", "capability-tour", "SKILL.md"), "utf8")).toContain(
		"capability tour",
	)
	const environment = { PATH: "/usr/bin:/bin", HOME: installedRoot }
	const helloWorld = Bun.spawnSync({
		cmd: [
			process.execPath,
			join(installedRoot, result.bundles["hello-world"].path),
			"hello",
			"--json",
		],
		cwd: installedRoot,
		env: { ...environment, HELLO_WORLD_RUN_ID: "relocated-offline-proof" },
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(helloWorld.stderr.toString()).toBe("")
	expect(helloWorld.exitCode).toBe(0)
	expect(JSON.parse(helloWorld.stdout.toString())).toEqual({
		ok: true,
		command: "hello",
		message: "Hello, world!",
		sideEffects: "none",
		runId: "relocated-offline-proof",
	})

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
	cpSync(
		join(root, "runtime", "runtime.lock.json"),
		join(fixtureRoot, "runtime", "runtime.lock.json"),
	)
	cpSync(
		join(root, "runtime", "skill-catalog.json"),
		join(fixtureRoot, "runtime", "skill-catalog.json"),
	)
	cpSync(join(root, "plugin"), join(fixtureRoot, "plugin"), {
		recursive: true,
	})
	return fixtureRoot
}

test("Bun-only release admission accepts the complete current payload", () => {
	expect(() => validateBunOnlyPayload(bunPayloadFixture())).not.toThrow()
})

test("Bun-only release admission rejects an arbitrary model-only skill", () => {
	const fixtureRoot = bunPayloadFixture()
	mkdirSync(join(fixtureRoot, "plugin", "skills", "unexpected-model-skill"), {
		recursive: true,
	})
	writeFileSync(
		join(fixtureRoot, "plugin", "skills", "unexpected-model-skill", "SKILL.md"),
		"# Unexpected model skill\n",
	)
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/skill sidecar inventory/)
})

test("Bun-only release admission rejects an arbitrary executable sidecar", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", "hooks", "unexpected-handler"), "#!/bin/sh\n")
	chmodSync(join(fixtureRoot, "plugin", "hooks", "unexpected-handler"), 0o755)
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/hook sidecar inventory/)
})

test.each([
	[
		"hooks/native-capability-hook",
		"Bun payload closure: missing hooks/native-capability-hook",
	],
	["assets/logo.svg", "Bun payload closure: missing assets/logo.svg"],
	[
		"skills/capability-tour/references/capability-reviewer.md",
		'unsafe plugin payload entry "plugin/skills/capability-tour/references": empty directory',
	],
] as const)("Bun-only release admission rejects missing capability sidecar %s", (path, rejection) => {
	const fixtureRoot = bunPayloadFixture()
	rmSync(join(fixtureRoot, "plugin", path))
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(rejection)
})

test("Bun-only release admission rejects a non-executable native hook", () => {
	const fixtureRoot = bunPayloadFixture()
	chmodSync(join(fixtureRoot, "plugin", "hooks", "native-capability-hook"), 0o644)
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(
		"Bun payload closure: hooks/native-capability-hook is not executable",
	)
})

test.each([
	"assets/orphan.svg",
	"skills/capability-tour/references/orphan.md",
] as const)("Bun-only release admission rejects orphaned capability sidecar %s", (path) => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", path), "orphan\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/sidecar inventory/)
})

test("Bun-only release admission rejects an unsupported component surface", () => {
	const fixtureRoot = bunPayloadFixture()
	mkdirSync(join(fixtureRoot, "plugin", "mcp"))
	writeFileSync(join(fixtureRoot, "plugin", "mcp", "server.json"), "{}\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/unsupported payload surface mcp/)
})

test("Bun-only release admission rejects a legacy runtime surface", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", "runtime", "qjs-legacy"), "legacy\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(/legacy runtime surface/)
})

test("Bun-only release admission rejects an unlisted runtime executable", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", "runtime", "rogue.sh"), "#!/bin/sh\n")
	chmodSync(join(fixtureRoot, "plugin", "runtime", "rogue.sh"), 0o755)
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(
		/unexpected payload file runtime\/rogue\.sh/,
	)
})

test("Bun-only release admission rejects an unlisted manifest sidecar", () => {
	const fixtureRoot = bunPayloadFixture()
	writeFileSync(join(fixtureRoot, "plugin", ".claude-plugin", "extra.json"), "{}\n")
	expect(() => validateBunOnlyPayload(fixtureRoot)).toThrow(
		/unexpected payload file \.claude-plugin\/extra\.json/,
	)
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
	mkdirSync(join(fixtureRoot, "plugin", "skills", "skill-a"), {
		recursive: true,
	})
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

test("build and closure validation reject unsupported non-workspace runtime entries", async () => {
	const fixtureRoot = closureFixture()
	const catalogPath = join(fixtureRoot, "runtime", "skill-catalog.json")
	const catalog = JSON.parse(readFileSync(catalogPath, "utf8"))
	delete catalog.skills["skill-a"].workspace
	writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`)
	await expect(buildWorkspaceBundles(fixtureRoot)).rejects.toMatchObject({
		code: "unsupported-entry",
	})
	expect(() => validateBundleClosure(fixtureRoot)).toThrow(
		/unsupported non-workspace runtime entry for skill-a/,
	)
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
	writeFileSync(join(fixtureRoot, "plugin", "runtime", mismatchedName), "console.log('bundled');\n")
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

test("packaging admission fails on a stale copied bundle before any archive is produced", () => {
	const fixtureRoot = temporaryDirectory("stale-package-copy-")
	for (const directory of ["plugin", "runtime", "scripts"]) {
		cpSync(join(root, directory), join(fixtureRoot, directory), {
			recursive: true,
		})
	}
	for (const file of ["package.json", "plugin.config.json"]) {
		cpSync(join(root, file), join(fixtureRoot, file))
	}
	const inventoryPath = join(fixtureRoot, "plugin", "runtime", "bundle-inventory.json")
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
	const [skillId] = Object.keys(inventory.bundles)
	const bundlePath = join(fixtureRoot, "plugin", inventory.bundles[skillId].path)
	writeFileSync(bundlePath, "console.log('tampered');\n")
	const packaged = Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/package.ts"],
		cwd: fixtureRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(packaged.exitCode).not.toBe(0)
	expect(packaged.stderr.toString()).toContain(`stale bundle for ${skillId}`)
	expect(existsSync(join(fixtureRoot, "dist"))).toBe(false)
})

test("bundle inventory quotes skill ids as literal shell case patterns", () => {
	const projection = renderBundleInventoryProjection({
		"skill-a|*) echo unsafe": {
			path: "runtime/safe.js",
			bytes: 1,
			sha256: "0".repeat(64),
		},
	})
	expect(projection).toContain("\t'skill-a|*) echo unsafe')")
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
