# Install, upgrade, or roll back a release

Use this guide when changing a production plugin installation in Claude Code or Codex.

Consumers need Claude Code or Codex and Git access to the repository. They do not need a user-managed Bun, Node.js, Python, npm, or setup command. First use with a missing runtime requires one approved repair; warm use works offline. Maintainers running `bun run update -- --harness codex --target latest` also need GitHub CLI read access for Release discovery. Explicit target tags use the configured Git credential path directly.

The verification recipes also use a POSIX shell, `curl`, `jq`, `awk`, and `diff`.

## Preflight a release tag

Inspect a release before changing either client. Set `FETCH_URL` to the same Git transport the marketplace will use. A public repository can use HTTPS. A private repository needs durable Git credentials because foreground installation and later background refreshes run Git independently.

```sh
set -eu
: "${TAG:=vX.Y.Z}"
: "${FETCH_URL:=https://github.com/OWNER/REPOSITORY.git}"
: "${PREFLIGHT_ROOT:=$(mktemp -d)}"
git clone --filter=blob:none --no-checkout "$FETCH_URL" "$PREFLIGHT_ROOT/repository"
git -C "$PREFLIGHT_ROOT/repository" fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"
REMOTE_SHA=$(git -C "$PREFLIGHT_ROOT/repository" rev-parse "refs/tags/$TAG^{commit}")
test -n "$REMOTE_SHA"
git -C "$PREFLIGHT_ROOT/repository" checkout --detach "$REMOTE_SHA"
test "$(git -C "$PREFLIGHT_ROOT/repository" rev-parse HEAD)" = "$REMOTE_SHA"
VERSION=${TAG#v}
test "$(jq -r .version "$PREFLIGHT_ROOT/repository/plugin/.claude-plugin/plugin.json")" = "$VERSION"
test "$(jq -r .version "$PREFLIGHT_ROOT/repository/plugin/.codex-plugin/plugin.json")" = "$VERSION"
jq -e '.plugins | length == 1 and .[0].defaultEnabled == false' "$PREFLIGHT_ROOT/repository/.claude-plugin/marketplace.json"
jq -e '.plugins | length == 1 and .[0].policy.installation == "AVAILABLE" and .[0].policy.authentication == "ON_INSTALL"' "$PREFLIGHT_ROOT/repository/.agents/plugins/marketplace.json"
test -z "$(git -C "$PREFLIGHT_ROOT/repository" ls-tree -r "$REMOTE_SHA" plugin | awk '$1 == "120000"')"
git -C "$PREFLIGHT_ROOT/repository" ls-tree -r "$REMOTE_SHA" plugin > "$PREFLIGHT_ROOT/payload-inventory.txt"
```

For private SSH, obtain GitHub's published Ed25519 host key over trusted HTTPS, isolate it in an explicit known-hosts file, and load the repository key before preflight:

```sh
GITHUB_KNOWN_HOSTS="$PREFLIGHT_ROOT/github-known-hosts"
curl --fail --silent --show-error https://api.github.com/meta \
  | jq -r '.ssh_keys[] | select(startswith("ssh-ed25519 ")) | "github.com " + .' \
  > "$GITHUB_KNOWN_HOSTS"
test -s "$GITHUB_KNOWN_HOSTS"
chmod 600 "$GITHUB_KNOWN_HOSTS"
GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$GITHUB_KNOWN_HOSTS"
export GIT_SSH_COMMAND
set +e
SSH_GREETING=$(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$GITHUB_KNOWN_HOSTS" -T git@github.com 2>&1)
SSH_STATUS=$?
set -e
printf '%s\n' "$SSH_GREETING"
if test "$SSH_STATUS" -ne 1; then
  echo "unexpected GitHub SSH greeting status: $SSH_STATUS" >&2
  exit 1
fi
ssh-keygen -F github.com -f "$GITHUB_KNOWN_HOSTS"
ssh-add -l
TAG=vX.Y.Z
FETCH_URL=git@github.com:OWNER/REPOSITORY.git
REMOTE_TAG=$(git ls-remote --refs "$FETCH_URL" "refs/tags/$TAG")
test -n "$REMOTE_TAG"
```

GitHub's successful SSH authentication greeting may exit with status 1 because it does not provide shell access. Verify the account named by the greeting before continuing. Launch Claude Code or Codex from this shell so subsequent Git operations inherit the same `GIT_SSH_COMMAND` and explicit known-hosts file.

For private HTTPS, configure a Git credential helper, then prove it can fetch the tag:

```sh
git config --get credential.helper
TAG=vX.Y.Z
FETCH_URL=https://github.com/OWNER/REPOSITORY.git
REMOTE_TAG=$(git ls-remote --refs "$FETCH_URL" "refs/tags/$TAG")
test -n "$REMOTE_TAG"
```

A token present only in an environment variable is insufficient. Continue only after `git ls-remote` succeeds through the same SSH agent and known-hosts file, or the same HTTPS credential helper, that the client will inherit. Keep `$PREFLIGHT_ROOT`; it is the restoration and byte-comparison source if replacement fails.

Preflight completes when the detached checkout, generated versions, marketplace policy, and payload inventory all match the requested immutable tag.

## Install in Claude Code

These first-install examples use the default `user` scope. Run the preflight first.

For a public GitHub repository:

```sh
claude plugin marketplace add OWNER/REPOSITORY@vX.Y.Z
claude plugin marketplace list --json > "$PREFLIGHT_ROOT/claude-marketplaces-after-add.json"
claude plugin install PLUGIN_NAME@PLUGIN_NAME --scope user
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-disabled.json"
claude plugin enable PLUGIN_NAME@PLUGIN_NAME --scope user
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-active.json"
```

For a private repository over SSH:

```sh
claude plugin marketplace add git@github.com:OWNER/REPOSITORY.git#vX.Y.Z
claude plugin marketplace list --json > "$PREFLIGHT_ROOT/claude-marketplaces-after-add.json"
claude plugin install PLUGIN_NAME@PLUGIN_NAME --scope user
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-disabled.json"
claude plugin enable PLUGIN_NAME@PLUGIN_NAME --scope user
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-active.json"
```

An HTTPS private source uses `https://github.com/OWNER/REPOSITORY.git#vX.Y.Z` after the credential-helper preflight. For `project` or `local`, append the same `--scope project` or `--scope local` to marketplace add, install, enable, uninstall, and marketplace remove. Keep one scope throughout replacement.

Inspect `claude-marketplaces-after-add.json` before installation. Confirm the marketplace name, pinned source, tag, scope, and host-selected snapshot match the preflight. Then verify the active install and its bytes:

```sh
jq -e '.[] | select(.id == "PLUGIN_NAME@PLUGIN_NAME" and .scope == "user" and .version == "X.Y.Z" and .enabled == true)' "$PREFLIGHT_ROOT/claude-plugins-active.json"
INSTALL_PATH=$(jq -r '.[] | select(.id == "PLUGIN_NAME@PLUGIN_NAME" and .scope == "user") | .installPath' "$PREFLIGHT_ROOT/claude-plugins-active.json")
diff -qr "$PREFLIGHT_ROOT/repository/plugin" "$INSTALL_PATH"
```

Generated Claude manifests install disabled by default. Claude Code clients older than `2.1.154` ignore `defaultEnabled: false`; use a supported client for this review-before-enable sequence. Start a new session or run `/reload-plugins` after verification. Claude automatic updates remain a user or team policy choice.

Installation completes when the enabled version, selected scope, and installed bytes match the preflight checkout.

The replacement recipe below preserves the scope and persistent data. Remove the pinned marketplace entry only after both target and restoration preflights pass.

Official references: [plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [plugins](https://code.claude.com/docs/en/plugins), and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

## Install in Codex

Supported Codex surfaces: Codex CLI and Codex in the ChatGPT desktop app. This repository does not claim support for the IDE extension, Chat, mobile, or a universal Codex host.

Run the preflight first. For a public GitHub repository:

```sh
codex plugin marketplace add OWNER/REPOSITORY --ref vX.Y.Z
codex plugin marketplace list --json > "$PREFLIGHT_ROOT/codex-marketplaces-after-add.json"
codex plugin add PLUGIN_NAME@PLUGIN_NAME --json > "$PREFLIGHT_ROOT/codex-plugin-add.json"
codex plugin list --json > "$PREFLIGHT_ROOT/codex-plugins-after-add.json"
```

For a private repository over SSH:

```sh
codex plugin marketplace add git@github.com:OWNER/REPOSITORY.git --ref vX.Y.Z
codex plugin marketplace list --json > "$PREFLIGHT_ROOT/codex-marketplaces-after-add.json"
codex plugin add PLUGIN_NAME@PLUGIN_NAME --json > "$PREFLIGHT_ROOT/codex-plugin-add.json"
codex plugin list --json > "$PREFLIGHT_ROOT/codex-plugins-after-add.json"
```

An HTTPS private source uses `https://github.com/OWNER/REPOSITORY.git` with the same `--ref vX.Y.Z` after the credential-helper preflight. Codex has no Claude scope and does not use Claude's default-disabled installation behavior.

Inspect the marketplace snapshot and installed plugin before starting a task:

```sh
MARKETPLACE_ROOT=$(jq -r '.marketplaces[] | select(.name == "PLUGIN_NAME") | .root' "$PREFLIGHT_ROOT/codex-marketplaces-after-add.json")
INSTALLED_PATH=$(jq -r .installedPath "$PREFLIGHT_ROOT/codex-plugin-add.json")
test -d "$MARKETPLACE_ROOT"
test -d "$INSTALLED_PATH"
cmp "$PREFLIGHT_ROOT/repository/.agents/plugins/marketplace.json" "$MARKETPLACE_ROOT/.agents/plugins/marketplace.json"
diff -qr "$PREFLIGHT_ROOT/repository/plugin" "$INSTALLED_PATH"
jq -e '.installed[] | select(.pluginId == "PLUGIN_NAME@PLUGIN_NAME" and .version == "X.Y.Z")' "$PREFLIGHT_ROOT/codex-plugins-after-add.json"
```

Start an isolated task with `codex -C "$PREFLIGHT_ROOT"` and invoke one installed skill. A missing runtime returns `BUN_MISSING` without mutation. The agent previews the verified repair, asks for approval in plain language, runs `runtime/runtime-exec repair --apply` only after approval, and retries the skill. The lifecycle sidecar is a mechanics proof; it never installs, repairs, or configures the runtime.

Installation completes when the version, marketplace snapshot, installed bytes, and one skill invocation match the preflight checkout.

The replacement recipe below preserves the marketplace source, ref, and prior `enabled` state. Remove the pinned marketplace entry only after target and restoration preflights pass.

Official references: [build Codex plugins](https://developers.openai.com/plugins/build/plugins), [Codex plugins](https://learn.chatgpt.com/docs/plugins), and [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Upgrade and roll back

An upgrade and a rollback use the same replacement operation. Set the target to the newer tag for an upgrade or the older tag for a rollback. First capture current JSON state. Run the detached preflight above twice: retain the selected target under `TARGET_PREFLIGHT_ROOT`, and retain the current restoration Release under `RESTORE_PREFLIGHT_ROOT`. Stop before uninstalling anything if either tag, commit, credential path, policy, payload, prior cache, or removal authority cannot be proved. Managed, workspace-installed, or non-removable plugins require an administrator.

```sh
TARGET_PREFLIGHT_ROOT=$(mktemp -d)
RESTORE_PREFLIGHT_ROOT=$(mktemp -d)
# Run the complete preflight with PREFLIGHT_ROOT=$TARGET_PREFLIGHT_ROOT and TAG=$TARGET_TAG.
# Run it again with PREFLIGHT_ROOT=$RESTORE_PREFLIGHT_ROOT and TAG=$RESTORE_TAG.
```

### Claude Code replacement

Record `SCOPE`, `PRIOR_CLAUDE_SOURCE`, `PRIOR_ENABLED`, and the prior active cache from the JSON snapshots. Set `TARGET_CLAUDE_SOURCE` to the exact public, SSH, or HTTPS source with its tag. Preserve the same scope throughout:

```sh
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-before.json"
claude plugin marketplace list --json > "$PREFLIGHT_ROOT/claude-marketplaces-before.json"
claude plugin uninstall PLUGIN_NAME@PLUGIN_NAME --keep-data --scope "$SCOPE"
claude plugin marketplace remove PLUGIN_NAME --scope "$SCOPE"
claude plugin marketplace add "$TARGET_CLAUDE_SOURCE" --scope "$SCOPE"
claude plugin marketplace list --json > "$PREFLIGHT_ROOT/claude-marketplaces-target.json"
claude plugin install PLUGIN_NAME@PLUGIN_NAME --scope "$SCOPE"
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-target-disabled.json"
claude plugin enable PLUGIN_NAME@PLUGIN_NAME --scope "$SCOPE"
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-target-active.json"
```

Inspect the target marketplace JSON before install. After enablement, require the target version, intended scope, host-selected active cache path, and `diff -qr` equality with `$TARGET_PREFLIGHT_ROOT/repository/plugin`. Ignore orphan cache directories that the host did not select.

If any step after uninstall fails, restore before doing other work:

```sh
claude plugin uninstall PLUGIN_NAME@PLUGIN_NAME --keep-data --scope "$SCOPE" || true
claude plugin marketplace remove PLUGIN_NAME --scope "$SCOPE" || true
claude plugin marketplace add "$PRIOR_CLAUDE_SOURCE" --scope "$SCOPE"
claude plugin install PLUGIN_NAME@PLUGIN_NAME --scope "$SCOPE"
if test "$PRIOR_ENABLED" = true; then
  claude plugin enable PLUGIN_NAME@PLUGIN_NAME --scope "$SCOPE"
else
  claude plugin disable PLUGIN_NAME@PLUGIN_NAME --scope "$SCOPE"
fi
claude plugin list --json > "$PREFLIGHT_ROOT/claude-plugins-restored.json"
```

Verify the restored version, scope, active cache bytes against `$RESTORE_PREFLIGHT_ROOT/repository/plugin`, enabled state, and persistent plugin data. Keep the persistent plugin data directory. Private background refresh uses the configured Git credential path. Set `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` in Claude Code's launch environment before starting the client. With it, a failed marketplace pull retains the last-known-good clone. Without it, Claude Code deletes and re-clones the marketplace after a failed pull, so prior marketplace cache retention is not guaranteed. Run `claude plugin marketplace update PLUGIN_NAME` for a manual same-source refresh, then inspect before replacement.

### Codex production update

Use the repository-owned command for every production upgrade or rollback. No arguments show concise help. A normal invocation is read-only and prints the prior ref, selected Release, and next action. JSON mode provides the detailed preview contract, including captured prior state, exact side effects, and recovery plan:

```sh
bun run update -- --harness codex
bun run update -- --harness codex --target vX.Y.Z
```

`--target latest` is the default. It selects the highest stable GitHub Release and excludes drafts and prereleases. An explicit stable `vX.Y.Z` tag keeps the run deterministic. The command resolves the selector once, peels the tag to one commit, and preflights both target and restoration Releases through the current Git transport before removal.

Review the preview, then authorize that exact target:

```sh
bun run update -- --harness codex --target vX.Y.Z --apply
bun run update -- --harness codex --target vX.Y.Z --apply --json --no-input
```

Apply removes the prior Plugin Installation and Marketplace, adds the same source pinned to the selected tag, verifies the Marketplace checkout before installation, installs the Plugin Payload, then checks configured ref, exact tag, peeled commit, manifest version, installed path, policy, enabled state, payload bytes, and selected-Release functional proof. An already-current Release returns `changed: false` without native remove or add commands.

The command blocks before mutation for unowned, ambiguous, sparse, disabled, non-stable, uncredentialed, unsafe, or unrestorable state. Codex CLI has no supported plugin enable/disable subcommand, so a disabled installation needs an administrator-owned replacement path. After a recoverable post-removal failure, the command attempts one exact restoration and verifies it. An unverified state returns `transactionState: "unknown"`, `retrySafety: "inspect_required"`, and never retries automatically.

JSON mode emits one result on stdout. Diagnostics stay on stderr. The result includes run correlation, selected and prior Release evidence, resulting ref/version/path, transaction state, completed side effects, retry safety, proof lineage, and one next safe action. Preview reports `proof.status: "target_preflight"` and leaves the live Marketplace and Plugin Installation on their prior Release; only a no-op or verified apply reports `proof.status: "installed_match"`. Fresh-install qualification stays separate from in-place-update proof.

`codex plugin marketplace upgrade PLUGIN_NAME` refreshes the configured Git snapshot only. It does not select a newer Release. A pinned immutable tag should resolve to the same bytes. Automatic Codex marketplace refresh is unspecified; never rely on a zero-error refresh result as release-selection evidence.

After a successful update, start a fresh isolated task, confirm skill discovery, and exercise the missing-runtime repair/retry journey when the reviewed Bun identity changed. A new Bun version plus executable digest requires fresh approval; archive-only metadata changes do not change the approved runtime identity.

Replacement completes when the target state matches `$TARGET_PREFLIGHT_ROOT` or the restored state matches `$RESTORE_PREFLIGHT_ROOT`: source, immutable ref, version, enabled state, installed bytes, and skill invocation must agree with that retained checkout.
