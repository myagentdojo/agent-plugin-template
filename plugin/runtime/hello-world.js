// @bun
// Generated from runtime/src/. Edit source, then run bun run build.
function R(D="",U=""){return{exitCode:0,stdout:D,stderr:U}}function W(D){return{exitCode:2,stdout:"",stderr:`hello-world: ${D}
Run hello-world --help for usage.
`}}function k(D,U){let L=D.indexOf(U);if(L===-1)return;return D[L+1]}function q(){return`Usage:
  hello-world hello [--name <name>] [--json]
  hello-world --help

Commands:
  hello  Print a greeting. No files, network calls, or durable state.
`}function N(D,U){let[L,...v]=D;if(L===void 0||L==="--help"||L==="-h")return R(q());if(L==="hello"){let H=k(v,"--name")??"world";if(v.includes("--json"))return R(`${JSON.stringify({ok:!0,command:"hello",message:`Hello, ${H}!`,sideEffects:"none",runId:U})}
`);return R(`Hello, ${H}!
`)}return W(`unknown command: ${L}`)}var O=N(process.argv.slice(2),process.env.HELLO_WORLD_RUN_ID??crypto.randomUUID());if(O.stdout)process.stdout.write(O.stdout);if(O.stderr)process.stderr.write(O.stderr);process.exit(O.exitCode);
