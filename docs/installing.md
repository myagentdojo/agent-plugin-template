# Install, upgrade, or roll back a release

Use this guide when changing a production plugin installation in Claude Code or Codex.

Consumers need Claude Code or Codex and Git access to the repository. They do not need a user-managed Bun, Node.js, Python, npm, or setup command. First use with a missing runtime requires one approved repair; warm use works offline.

The verification recipes also use a POSIX shell, `curl`, `jq`, `awk`, and `diff`.

## Preflight a release tag

Inspect a release before changing either client. Set `FETCH_URL` to the same Git transport the marketplace will use. A public repository can use HTTPS. A private repository needs durable Git credentials because foreground installation and later background refreshes run Git independently.

```sh
set -eu
TAG=vX.Y.Z
FETCH_URL=https://github.com/OWNER/REPOSITORY.git
PREFLIGHT_ROOT=$(mktemp -d)
git clone --filter=blob:none --no-checkout "$FETCH_URL" "$PREFLIGHT_ROOT/repository"
git -C "$PREFLIGHT_ROOT/repository" fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"
REMOTE_SHA=$(git -C "$PREFLIGHT_ROOT/repository" rev-parse "refs/tags/$TAG^{commit}")
test -n "$REMOTE_SHA"
git -C "$PREFLIGHT_ROOT/repository" checkout --detach "$REMOTE_SHA"
test "$(git -C "$PREFLIGHT_ROOT/repository" rev-parse HEAD)" = "$REMOTE_SHA"
VERSION=${TAG#v}
test "$(jq -r .version "$PREFLIGHT_ROOT/repository/plugin/.claude-plugin/plugin.json")" = "$VERSION"
test "$(jq -r .version "$PREFLIGHT_ROOT/repository/plugin/.codex-plugin/plugin.json")" = "$VERSION"
jq -e '.plugins[0].defaultEnabled == false' "$PREFLIGHT_ROOT/repository/.claude-plugin/marketplace.json"
jq -e '.plugins[0].policy.installation == "AVAILABLE" and .plugins[0].policy.authentication == "ON_INSTALL"' "$PREFLIGHT_ROOT/repository/.agents/plugins/marketplace.json"
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

An upgrade and a rollback use the same replacement operation. Set the target to the newer tag for an upgrade or the older tag for a rollback. First capture current JSON state. Run the detached preflight above for both the target tag and the current restoration tag. Stop before uninstalling anything if either tag, commit, credential path, policy, payload, prior cache, or removal authority cannot be proved. Managed, workspace-installed, or non-removable plugins require an administrator.

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

Inspect the target marketplace JSON before install. After enablement, require the target version, intended scope, host-selected active cache path, and `diff -qr` equality with the target checkout. Ignore orphan cache directories that the host did not select.

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

Verify the restored version, scope, active cache bytes, enabled state, and persistent plugin data. Keep the persistent plugin data directory. Private background refresh uses the configured Git credential path. Set `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` in Claude Code's launch environment before starting the client. With it, a failed marketplace pull retains the last-known-good clone. Without it, Claude Code deletes and re-clones the marketplace after a failed pull, so prior marketplace cache retention is not guaranteed. Run `claude plugin marketplace update PLUGIN_NAME` for a manual same-source refresh, then inspect before replacement.

### Codex replacement

Capture marketplace and plugin JSON first. Record `PRIOR_CODEX_SOURCE`, `PRIOR_CODEX_REF`, and `PRIOR_ENABLED`. Preflight both the target and restoration refs before removal:

```sh
codex plugin marketplace list --json > "$PREFLIGHT_ROOT/codex-marketplaces-before.json"
codex plugin list --json > "$PREFLIGHT_ROOT/codex-plugins-before.json"
codex plugin remove PLUGIN_NAME@PLUGIN_NAME --json
codex plugin marketplace remove PLUGIN_NAME --json
codex plugin marketplace add "$TARGET_CODEX_SOURCE" --ref "$TARGET_CODEX_REF" --json > "$PREFLIGHT_ROOT/codex-marketplace-target-add.json"
codex plugin marketplace list --json > "$PREFLIGHT_ROOT/codex-marketplaces-target.json"
codex plugin add PLUGIN_NAME@PLUGIN_NAME --json > "$PREFLIGHT_ROOT/codex-plugin-target-add.json"
codex plugin list --json > "$PREFLIGHT_ROOT/codex-plugins-target.json"
```

Inspect the marketplace JSON and installed root before plugin add. Then inspect the plugin JSON and installed path. Require the target source/ref, version, and byte equality with the detached target checkout.

If any step after removal fails, restore the exact prior source and ref immediately:

```sh
codex plugin remove PLUGIN_NAME@PLUGIN_NAME --json || true
codex plugin marketplace remove PLUGIN_NAME --json || true
codex plugin marketplace add "$PRIOR_CODEX_SOURCE" --ref "$PRIOR_CODEX_REF" --json > "$PREFLIGHT_ROOT/codex-marketplace-restored-add.json"
codex plugin add PLUGIN_NAME@PLUGIN_NAME --json > "$PREFLIGHT_ROOT/codex-plugin-restored-add.json"
codex plugin marketplace list --json > "$PREFLIGHT_ROOT/codex-marketplaces-restored.json"
codex plugin list --json > "$PREFLIGHT_ROOT/codex-plugins-restored.json"
```

Verify the restored source, ref, version, cache bytes, and enabled state. Codex CLI currently has no documented plugin enable/disable subcommand; restore a differing enabled state in the Codex plugin settings and confirm it with `codex plugin list --json` before continuing.

For the target install, start a fresh isolated task, confirm skill discovery, and exercise the missing-runtime repair/retry journey when the reviewed Bun identity changed. A new Bun version plus executable digest requires fresh approval; archive-only metadata changes do not change the approved runtime identity.

`codex plugin marketplace upgrade PLUGIN_NAME` is the documented explicit CLI operation for refreshing the configured Git snapshot. A pinned immutable tag should resolve to the same bytes. Automatic Codex marketplace refresh is unspecified; never rely on it to move or restore a release.

Replacement completes when the target or restored source, immutable ref, version, enabled state, installed bytes, and skill invocation all match the selected preflight checkout.
