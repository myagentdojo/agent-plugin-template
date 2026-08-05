// PROTOTYPE — throwaway. The QuickJS host-shim layer the ADR calls for.
// QuickJS-NG 0.16.1 ships no Web Crypto. This bridges crypto.getRandomValues
// to a REAL entropy source (/dev/urandom via qjs:std) — never Math.random,
// which would make nanoid/uuid identifiers predictable.
import * as std from "qjs:std"

function fillFromUrandom(target: Uint8Array): Uint8Array {
	const f = std.open("/dev/urandom", "rb")
	const buffer = new Uint8Array(target.length)
	f.read(buffer.buffer, 0, buffer.length)
	f.close()
	target.set(buffer)
	return target
}

// Install once, before any bundled lib runs.
export function installHostShims(): void {
	const g = globalThis as Record<string, unknown>
	if (!g.crypto) {
		g.crypto = {
			getRandomValues<T extends ArrayBufferView>(array: T): T {
				fillFromUrandom(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
				return array
			},
		}
	}
}
