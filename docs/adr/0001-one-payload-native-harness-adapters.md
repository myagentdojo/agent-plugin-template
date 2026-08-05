# Distribute one payload through native harness adapters

The Plugin Repository produces one Plugin Payload for Claude Code and Codex. Skills and portable behavior are shared, while each Harness keeps its own manifest and hook declarations because discovery, trust, matching, and reload semantics differ. A shared default hook path was rejected after live testing showed one Harness could auto-discover the other's declaration; syncing or symlinking skills alone was rejected because it omits the rest of the Plugin Payload.
