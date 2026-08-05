# Publish reviewed versioned releases

Normal pull requests may merge into `main` without publishing. Release Please maintains a human-reviewed release pull request; merging it establishes the semantic version and permits the proven commit to become a Git tag, GitHub Release, and deterministic Plugin Payload. npm and publish-on-every-merge were rejected because the Harness marketplaces already install from Git and maintainers need an explicit batching boundary.
