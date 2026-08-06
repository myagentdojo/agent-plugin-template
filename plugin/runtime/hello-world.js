// Generated from runtime/src/. Edit source, then run bun run build.
// x-release-please-start-version
const PLUGIN_VERSION = "0.1.0";
// x-release-please-end
import*as D from"qjs:std";function S(L="",q=""){return{exitCode:0,stdout:L,stderr:q}}function H(L){return{exitCode:2,stdout:"",stderr:`hello-world: ${L}
Run hello-world --help for usage.
`}}function $(L,q){let W=L.indexOf(q);if(W===-1)return;return L[W+1]}function B(){return`hello-world ${PLUGIN_VERSION}

Usage:
  hello-world hello [--name <name>] [--json]
  hello-world hook --harness claude --event <event>
  hello-world hook --harness codex --event <event> --plugin-version <version>
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
  hook   Accept a harness hook payload on stdin and exit successfully.

Hook options:
  --plugin-version <version>  Required for Codex hooks only.
`}function z(L,q,W){let[O,...N]=L;if(O===void 0||O==="--help"||O==="-h")return S(B());if(O==="--version"||O==="-v")return S(`${PLUGIN_VERSION}
`);if(O==="hello"){let R=$(N,"--name")??"world";if(N.includes("--json"))return S(`${JSON.stringify({ok:!0,command:"hello",message:`Hello, ${R}!`,sideEffects:"none",runId:W})}
`);return S(`Hello, ${R}!
`)}if(O==="hook"){let R=$(N,"--harness"),k=$(N,"--event"),j=$(N,"--plugin-version");if(R!=="codex"&&R!=="claude")return H("--harness must be codex or claude");if(!k)return H("--event is required");if(R==="codex"&&!j)return H("--plugin-version is required for codex hooks");if(j&&j!==PLUGIN_VERSION)return H(`--plugin-version must be ${PLUGIN_VERSION}`);if(q.trim())try{JSON.parse(q)}catch{return H("hook stdin must be JSON")}return S("",`hello-world hook: ${R} ${k}
`)}return H(`unknown command: ${O}`)}var E=D.in.readAsString(),F=D.getenv("HELLO_WORLD_RUN_ID")??`quickjs-${Date.now()}`,U=z(scriptArgs.slice(1),E,F);if(U.stdout)D.out.puts(U.stdout);if(U.stderr)D.err.puts(U.stderr);D.exit(U.exitCode);
