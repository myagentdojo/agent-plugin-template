#!/bin/sh
# Generated from bundle-inventory.json by scripts/build.ts. Edit workspace sources, then run bun run build.
runtime_inventory_select_bundle() {
	case "$1" in
	'hello-world')
		RUNTIME_BUNDLE_PATH='runtime/hello-world.js'
		RUNTIME_BUNDLE_BYTES='995'
		RUNTIME_BUNDLE_SHA256='aedde54417e663d86bb183dda8115095c48e53a9e9fc91d8b0d4dec4b09e6202'
		;;
	'skill-a')
		RUNTIME_BUNDLE_PATH='runtime/skill-a-27cb243179e5c93d.js'
		RUNTIME_BUNDLE_BYTES='7838'
		RUNTIME_BUNDLE_SHA256='27cb243179e5c93dc6d7c5730b483fcbf4adf82def672dddca476594a3e4bf80'
		;;
	'skill-b')
		RUNTIME_BUNDLE_PATH='runtime/skill-b-535431fb5dd1ed0a.js'
		RUNTIME_BUNDLE_BYTES='6422'
		RUNTIME_BUNDLE_SHA256='535431fb5dd1ed0a30a02105818a77bcbcadfa4395b029f614fe4283a7346ec7'
		;;
	*) return 1 ;;
	esac
}
