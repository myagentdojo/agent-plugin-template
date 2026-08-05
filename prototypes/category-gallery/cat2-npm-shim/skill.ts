// PROTOTYPE — throwaway. Category 2: pure-JS npm lib on QuickJS + host shim.
// Imports a REAL npm package (nanoid) that needs crypto.getRandomValues.
// The shim (bridged to /dev/urandom) is what makes it run under QuickJS.
import * as std from "qjs:std"
import { installHostShims } from "../shared/quickjs-host-shims"

installHostShims() // MUST run before nanoid touches crypto.

import { nanoid } from "nanoid"
import { z } from "zod"

// nanoid = crypto-dependent (proves the shim); zod = pure-JS (runs unshimmed).
const id = nanoid(12)
const parsed = z.object({ id: z.string().min(1) }).parse({ id })
std.out.puts(`cat2 (npm + shim): nanoid -> ${id} | zod validated len=${parsed.id.length}\n`)
std.exit(0)
