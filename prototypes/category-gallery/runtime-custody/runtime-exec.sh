#!/bin/sh
# PROTOTYPE — throwaway. Consensus DRY bootstrap: the ONE shared runtime-custody
# engine every OS-integrated skill routes through. POSIX shell stage-zero (Bun
# does not exist yet). Resolves skill -> profile -> platform asset, checks/repairs
# a SHARED cache with checksum verification, then execs verified Bun on the
# catalog-owned entry. Fails closed on unknown skill, checksum mismatch, or a
# missing prerequisite. No skill ever names a version/url/checksum/path.
set -eu

self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LOCK="$self_dir/runtime.lock.json"
CATALOG="$self_dir/catalog.json"
CACHE_ROOT="${RUNTIME_CUSTODY_CACHE:-$HOME/.cache/runtime-custody}"

die() { printf 'runtime-custody: %s\n' "$1" >&2; exit "${2:-1}"; }

# Minimal JSON reader via the platform's own tools. Prefer python3 (ubiquitous);
# this is stage-zero, so keep the dependency surface tiny and typed-fail if absent.
JSON="$(command -v python3 || true)"
[ -n "$JSON" ] || die "prerequisite missing: python3 (needed to read the lock/catalog)" 3
need() { command -v "$1" >/dev/null 2>&1 || die "prerequisite missing: $1" 3; }
need shasum || need sha256sum

jget() { "$JSON" -c "import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$1" "$2"; }

platform() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Darwin) os=darwin;; Linux) os=linux;; *) die "unsupported os: $os" 3;; esac
  case "$arch" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) die "unsupported arch: $arch" 3;; esac
  printf '%s-%s' "$os" "$arch"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# --- custody: ensure the pinned runtime is cached and checksum-verified ---
ensure_runtime() { # $1=profile -> prints verified bun path
  profile="$1"; plat=$(platform)
  ver=$(jget "$LOCK" "d['profiles']['$profile']['version']") || die "unknown profile: $profile" 2
  want_sha=$(jget "$LOCK" "d['profiles']['$profile']['assets']['$plat']['executableSha256']") \
    || die "no pinned asset for $profile/$plat" 2
  src=$(jget "$LOCK" "d['profiles']['$profile']['assets']['$plat']['url']")
  cache_dir="$CACHE_ROOT/$profile/$ver/$plat"; cached="$cache_dir/bun"

  if [ -f "$cached" ] && [ "$(sha256_of "$cached")" = "$want_sha" ]; then
    printf '%s' "$cached"; return 0        # cache hit — shared across ALL skills
  fi
  # acquire (transport abstracted for the prototype: file:// copy; prod = download)
  mkdir -p "$cache_dir"
  case "$src" in
    file://*) cp "${src#file://}" "$cached" ;;
    *) die "prototype transport only supports file:// (prod: checksum-pinned download of $src)" 4 ;;
  esac
  got=$(sha256_of "$cached")
  [ "$got" = "$want_sha" ] || { rm -f "$cached"; die "checksum mismatch for $profile/$plat: expected $want_sha got $got" 5; }
  chmod +x "$cached"
  printf '%s' "$cached"
}

cmd="${1:-}"; [ -n "$cmd" ] || die "usage: runtime-exec <run|doctor|repair> ..." 2
case "$cmd" in
  run)
    shift; skill="${1:-}"; [ -n "$skill" ] || die "run needs a skill id" 2; shift
    [ "${1:-}" = "--" ] && shift || true
    entry=$(jget "$CATALOG" "d['skills'].get('$skill',{}).get('entry','')")
    [ -n "$entry" ] || die "unknown skill: $skill (not in catalog — fail closed)" 2
    case "$entry" in /*|*..*) die "entry escapes plugin root: $entry" 2;; esac
    profile=$(jget "$CATALOG" "d['skills']['$skill']['runtimeProfile']")
    bun=$(ensure_runtime "$profile")
    exec "$bun" "$self_dir/$entry" "$@"
    ;;
  doctor)
    profile="${2:-bun}"
    if bun=$(ensure_runtime "$profile" 2>/dev/null); then
      printf '{"ok":true,"profile":"%s","runtime":"%s"}\n' "$profile" "$bun"
    else
      printf '{"ok":false,"profile":"%s","reason":"runtime not present or unverified; run repair"}\n' "$profile"; exit 1
    fi
    ;;
  repair)
    profile="${2:-bun}"; plat=$(platform)
    cache_dir="$CACHE_ROOT/$profile/$(jget "$LOCK" "d['profiles']['$profile']['version']")/$plat"
    rm -f "$cache_dir/bun"; bun=$(ensure_runtime "$profile")
    printf '{"ok":true,"repaired":"%s"}\n' "$bun"
    ;;
  --help|-h) printf 'runtime-exec run <skill-id> -- <args> | doctor [profile] | repair [profile]\n' ;;
  *) die "unknown command: $cmd" 2 ;;
esac
