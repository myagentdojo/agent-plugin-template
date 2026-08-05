// Generated from runtime/src/. Edit source, then run bun run build.
import*as D from"qjs:std";function H(L="",R=""){return{exitCode:0,stdout:L,stderr:R}}function W(L){return{exitCode:2,stdout:"",stderr:`hello-world: ${L}
Run hello-world --help for usage.
`}}function $(L,R){let S=L.indexOf(R);if(S===-1)return;return L[S+1]}function z(){return`hello-world 0.1.0

Usage:
  hello-world hello [--name <name>] [--json]
  hello-world hook --harness <codex|claude> --event <event>
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
  hook   Accept a harness hook payload on stdin and exit successfully.
`}function k(L,R,S){let[O,...U]=L;if(O===void 0||O==="--help"||O==="-h")return H(z());if(O==="--version"||O==="-v")return H(`0.1.0
`);if(O==="hello"){let q=$(U,"--name")??"world";if(U.includes("--json"))return H(`${JSON.stringify({ok:!0,command:"hello",message:`Hello, ${q}!`,sideEffects:"none",runId:S})}
`);return H(`Hello, ${q}!
`)}if(O==="hook"){let q=$(U,"--harness"),j=$(U,"--event");if(q!=="codex"&&q!=="claude")return W("--harness must be codex or claude");if(!j)return W("--event is required");if(R.trim())try{JSON.parse(R)}catch{return W("hook stdin must be JSON")}return H("",`hello-world hook: ${q} ${j}
`)}return W(`unknown command: ${O}`)}var B=D.in.readAsString(),E=D.getenv("HELLO_WORLD_RUN_ID")??`quickjs-${Date.now()}`,N=k(scriptArgs.slice(1),B,E);if(N.stdout)D.out.puts(N.stdout);if(N.stderr)D.err.puts(N.stderr);D.exit(N.exitCode);
