// PROTOTYPE — throwaway. Category 1: pure logic on QuickJS.
// No npm deps, no host globals beyond qjs:std. args + stdin -> stdout.
// This is what the template's hello-world already is; included for contrast.
import * as std from "qjs:std"

declare const scriptArgs: string[]

function reverseWords(line: string): string {
	return line.trim().split(/\s+/).reverse().join(" ")
}

const stdin = std.in.readAsString().trim()
const argv = scriptArgs.slice(1)
const input = stdin || argv.join(" ") || "hello portable world"
std.out.puts(`cat1 (pure logic): "${input}" -> "${reverseWords(input)}"\n`)
std.exit(0)
