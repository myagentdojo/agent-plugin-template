#!/bin/sh
# Generated from runtime/runtime.lock.json. Edit the source, then run bun run generate.
RUNTIME_LOCK_PROFILE='bun'
RUNTIME_LOCK_VERSION='1.3.14'

runtime_lock_select_asset() {
	case "$1" in
	darwin-arm64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-darwin-aarch64.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='23586433'
		RUNTIME_ASSET_ARCHIVE_SHA256='d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-darwin-aarch64/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='63096576'
		RUNTIME_ASSET_EXECUTABLE_SHA256='e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233'
		;;
	darwin-x64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-darwin-x64-baseline.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-x64-baseline.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='26509145'
		RUNTIME_ASSET_ARCHIVE_SHA256='3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-darwin-x64-baseline/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='69173328'
		RUNTIME_ASSET_EXECUTABLE_SHA256='ea2f223e94bb2f4bf3050895113c3cf346438f6fa0501c8532284e063f72f7a0'
		;;
	linux-arm64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-linux-aarch64.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='35700603'
		RUNTIME_ASSET_ARCHIVE_SHA256='a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-linux-aarch64/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='91801560'
		RUNTIME_ASSET_EXECUTABLE_SHA256='37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'
		;;
	linux-x64)
		RUNTIME_ASSET_ARCHIVE_NAME='bun-linux-x64-baseline.zip'
		RUNTIME_ASSET_URL='https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip'
		RUNTIME_ASSET_ARCHIVE_BYTES='35595658'
		RUNTIME_ASSET_ARCHIVE_SHA256='a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7'
		RUNTIME_ASSET_EXECUTABLE_PATH='bun-linux-x64-baseline/bun'
		RUNTIME_ASSET_EXECUTABLE_BYTES='91802480'
		RUNTIME_ASSET_EXECUTABLE_SHA256='a8f9ebd1770ddc8e55dab7a68d4ec1ec1eebf374bb97cc65cf2c3cb373fc6791'
		;;
	*) return 1 ;;
	esac
}
