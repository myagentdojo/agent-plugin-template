#!/bin/sh
# Generated from runtime/skill-catalog.json. Edit the source, then run bun run generate.
runtime_catalog_select_skill() {
	case "$1" in
	hello-world)
		RUNTIME_SKILL_ENTRY='runtime/hello-world.js'
		RUNTIME_SKILL_PROFILE='bun'
		;;
	skill-a)
		RUNTIME_SKILL_ENTRY='runtime/skill-a.js'
		RUNTIME_SKILL_PROFILE='bun'
		;;
	skill-b)
		RUNTIME_SKILL_ENTRY='runtime/skill-b.js'
		RUNTIME_SKILL_PROFILE='bun'
		;;
	*) return 1 ;;
	esac
}
