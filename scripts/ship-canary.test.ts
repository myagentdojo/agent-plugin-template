import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([".claude", ".dev", ".git", ".worktrees", "dist", "node_modules"])

function executable(path: string, contents: string): void {
	writeFileSync(path, contents)
	chmodSync(path, 0o755)
}

function canaryFixture(): { temporaryRoot: string; fakeBin: string; log: string } {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-plugin-template-canary-"))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	const initialized = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--author",
			"My Agent Dojo",
			"--repository",
			"https://github.com/myagentdojo/dojo-hello",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)

	const fakeBin = join(temporaryRoot, ".test-bin")
	const log = join(temporaryRoot, "commands.log")
	mkdirSync(fakeBin)
	executable(
		join(fakeBin, "gh"),
		`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo myagentdojo; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  case "$3" in
    *public-canary) echo PUBLIC ;;
    *private-canary) echo PRIVATE ;;
    *) exit 44 ;;
  esac
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  case "$4" in
    *public-canary) echo '[{"databaseId":101,"status":"completed","conclusion":"success","url":"https://github.com/public/run/101"}]' ;;
    *private-canary) echo '[{"databaseId":202,"status":"completed","conclusion":"success","url":"https://github.com/private/run/202"}]' ;;
    *) exit 45 ;;
  esac
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 90
`,
	)
	executable(
		join(fakeBin, "git"),
		`#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then echo git@github-myagentdojo:myagentdojo/dojo-hello.git; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then echo 0123456789abcdef0123456789abcdef01234567; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain" ]; then exit 0; fi
if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ]; then exit 0; fi
if [ "$1" = "push" ]; then printf '%s\n' "$*" >> "$FAKE_LOG"; exit 0; fi
echo "unexpected git command: $*" >&2
exit 91
`,
	)
	return { temporaryRoot, fakeBin, log }
}

function runCanary(
	fixture: ReturnType<typeof canaryFixture>,
	mode: "--dry-run" | "--execute",
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "ship:canary", "--", mode, "--json"],
		cwd: fixture.temporaryRoot,
		env: {
			...process.env,
			FAKE_LOG: fixture.log,
			PATH: `${fixture.fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("canary dry-run proves identity, visibility, and source without publishing", () => {
	const result = runCanary(canaryFixture(), "--dry-run")

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "preview",
		sideEffects: "none",
		identity: "myagentdojo",
		source: {
			ref: "origin/main",
			sha: "0123456789abcdef0123456789abcdef01234567",
		},
		targets: [
			{ repository: "myagentdojo/dojo-hello-public-canary", visibility: "PUBLIC" },
			{ repository: "myagentdojo/dojo-hello-private-canary", visibility: "PRIVATE" },
		],
	})
})

test("canary execute publishes both targets and waits for both hosted proofs", async () => {
	const fixture = canaryFixture()
	const result = runCanary(fixture, "--execute")

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "published",
		sideEffects: "github-repositories-updated",
		runs: [
			{ repository: "myagentdojo/dojo-hello-public-canary", conclusion: "success" },
			{ repository: "myagentdojo/dojo-hello-private-canary", conclusion: "success" },
		],
	})
	const pushes = await Bun.file(fixture.log).text()
	expect(pushes.match(/^push /gm)).toHaveLength(2)
})
