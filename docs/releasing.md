# Release maintainer index

Use the runbook that matches the current job:

| Job | Runbook |
| --- | --- |
| Name and qualify a pull request | [Pull requests and CI](pull-requests-and-ci.md) |
| Configure GitHub release automation | [Configure release automation](release-setup.md) |
| Record candidate-bound evidence from fresh clients | [Qualify fresh native capabilities](native-capability-qualification.md) |
| Publish an admitted candidate | [Publish a release](publishing.md) |
| Maintain the release PR or repair an incomplete publication | [Maintain or repair release state](release-repair.md) |
| Qualify publishing-system changes in public and private repositories | [Qualify public and private canaries](canary-qualification.md) |

The root [README](../README.md) owns plugin creation and extension. The [installation guide](installing.md) owns production installation, upgrade, replacement, and rollback.

## Distribution boundaries

- **Implemented Git marketplace:** deterministic `tar.gz`, `*.checksums.json`, optional public GitHub attestation, pinned public/private Git sources, and public/private Git canaries.
- **Deferred OpenAI universal directory:** separate public ZIP, assets, publisher identity, portal submission, review, approval, and publication. Passing the generated directory-readiness text subset does not complete any of these steps.
- **Deferred Anthropic `claude-community`:** separate submission form, safety review, and catalog commit-SHA pinning. This repository does not submit or approve that catalog entry.
