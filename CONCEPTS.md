# Concepts

## Plugin distribution

### Canonical plugin payload

The complete installable subtree that both harnesses, development staging, packaging, and distribution proofs consume without adding or removing recipient files.

### Portable runtime seam

The process-level contract through which shared plugin behavior accepts arguments, input, and invocation identity and returns output and an exit status without depending on a harness API.

### Native harness adapter

A host-specific manifest, hook declaration, or I/O boundary that translates one harness's discovery, trust, and lifecycle semantics into the portable runtime seam.

### Development marketplace

An ignored local marketplace containing a staged canonical plugin payload with a cache-busting development version, used when a harness cannot execute a plugin directly from its source directory.

## Relationships

The canonical plugin payload contains the portable runtime seam and one native harness adapter per supported host. A development marketplace is a temporary projection of that payload, not a second source of plugin files.
