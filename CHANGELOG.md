# Changelog

## [0.3.0](https://github.com/myagentdojo/agent-plugin-template/compare/v0.2.0...v0.3.0) (2026-08-10)


### Features

* add native plugin capability tour with lifecycle hook proof ([#34](https://github.com/myagentdojo/agent-plugin-template/issues/34)) ([bfe8489](https://github.com/myagentdojo/agent-plugin-template/commit/bfe8489434949a4d4003e3b0da29f4237aae8534))

## [0.2.0](https://github.com/myagentdojo/agent-plugin-template/compare/v0.1.1...v0.2.0) (2026-08-09)


### Features

* **runtime:** complete Bun-only runtime custody ([#22](https://github.com/myagentdojo/agent-plugin-template/issues/22)) ([e927c24](https://github.com/myagentdojo/agent-plugin-template/commit/e927c24e5f7cf270b7b10179e15495984d36cd4d))


### Bug Fixes

* **ci:** ignore remapped stale Codex findings ([#28](https://github.com/myagentdojo/agent-plugin-template/issues/28)) ([fbdd5d8](https://github.com/myagentdojo/agent-plugin-template/commit/fbdd5d8a6179dfe24b95b5c0cc6ee45fc1b72a45))
* **release:** allow lineage label reconciliation ([#27](https://github.com/myagentdojo/agent-plugin-template/issues/27)) ([7b81d73](https://github.com/myagentdojo/agent-plugin-template/commit/7b81d732ab303e683c4abec6361dbff94be04658))
* **release:** fail closed on skipped publication ([#26](https://github.com/myagentdojo/agent-plugin-template/issues/26)) ([c9067f6](https://github.com/myagentdojo/agent-plugin-template/commit/c9067f6156d239fa2524e9dd6966403e512e9a96))
* **release:** keep Release Please lineage current ([#23](https://github.com/myagentdojo/agent-plugin-template/issues/23)) ([d3f9bc7](https://github.com/myagentdojo/agent-plugin-template/commit/d3f9bc7b33a52bb0cab3f1e9f09b3958e8d3d9aa))
* **release:** preserve historical proof policy ([#25](https://github.com/myagentdojo/agent-plugin-template/issues/25)) ([a6041c9](https://github.com/myagentdojo/agent-plugin-template/commit/a6041c9e1bb0c08231a07d38b7f0960393eec1db))
* **release:** preserve historical repair policy ([#24](https://github.com/myagentdojo/agent-plugin-template/issues/24)) ([06f8454](https://github.com/myagentdojo/agent-plugin-template/commit/06f84548b219859427a44f6e19833752c66640b4))
* **release:** recover squashed 0.2.0 candidate ([478dcc4](https://github.com/myagentdojo/agent-plugin-template/commit/478dcc4ddd70812dc8ee9a32077a6cafbcccc5b3))
* **release:** support verified squash publication ([#33](https://github.com/myagentdojo/agent-plugin-template/issues/33)) ([60810cc](https://github.com/myagentdojo/agent-plugin-template/commit/60810cc0c7236404867ac0832ef91539c8dab5b4))

## [0.1.1](https://github.com/myagentdojo/agent-plugin-template/compare/v0.1.0...v0.1.1) (2026-08-07)


### Bug Fixes

* **ci:** bind canary identity to known hosts ([#20](https://github.com/myagentdojo/agent-plugin-template/issues/20)) ([d7c99b7](https://github.com/myagentdojo/agent-plugin-template/commit/d7c99b7efc3311fe4a5724eb895fd47b0389dc58))
* **ci:** bind hosted canary to key file ([#21](https://github.com/myagentdojo/agent-plugin-template/issues/21)) ([6efc6aa](https://github.com/myagentdojo/agent-plugin-template/commit/6efc6aa42cff51a6082cbf78bf0fffcd1b419c02))
* keep release qualification stable ([7ecc8f4](https://github.com/myagentdojo/agent-plugin-template/commit/7ecc8f48314e7939aac94af34454f75ef4eb5d33))
* report plugin version in hello JSON ([#16](https://github.com/myagentdojo/agent-plugin-template/issues/16)) ([85ef9ec](https://github.com/myagentdojo/agent-plugin-template/commit/85ef9ec24df24fa00830e449fd75517383a8c401))

## 0.1.0 (2026-08-06)


### Features

* add portable agent plugin template ([1ee7be1](https://github.com/myagentdojo/agent-plugin-template/commit/1ee7be1fe8fcfbec7f421b53bab0fb4a268e5c3b))
* finalize portable plugin template ([#6](https://github.com/myagentdojo/agent-plugin-template/issues/6)) ([fe4b7af](https://github.com/myagentdojo/agent-plugin-template/commit/fe4b7af112deb2423b7511998c33d0bcd878c211))
* harden native plugin publishing lifecycle ([#11](https://github.com/myagentdojo/agent-plugin-template/issues/11)) ([904d0cf](https://github.com/myagentdojo/agent-plugin-template/commit/904d0cf31f8e5c161c7ed7ad0e5663ce8215c3ef))
* productionize plugin releases and documentation ([#9](https://github.com/myagentdojo/agent-plugin-template/issues/9)) ([3f31de3](https://github.com/myagentdojo/agent-plugin-template/commit/3f31de39c712a70e2d9e5ad70ba47900d3330ccf))


### Bug Fixes

* **canary:** prove target lineage before publish ([#7](https://github.com/myagentdojo/agent-plugin-template/issues/7)) ([c2c0fdd](https://github.com/myagentdojo/agent-plugin-template/commit/c2c0fdd4b383dd84ec0e8eec961692addaf9bafd))
* **ci:** avoid artifact download deprecation ([#5](https://github.com/myagentdojo/agent-plugin-template/issues/5)) ([3b9b97e](https://github.com/myagentdojo/agent-plugin-template/commit/3b9b97ee5c8215899a6300c16d05616f9671a7e1))
* **ci:** fetch complete canary candidate history ([5d47466](https://github.com/myagentdojo/agent-plugin-template/commit/5d47466f0a3852b0c09b0049fddf649579327c32))
* **ci:** fetch complete canary candidate history ([de44763](https://github.com/myagentdojo/agent-plugin-template/commit/de4476324a6822e94fb7e40e6ce388133a982425))
* **ci:** preserve canary SSH agent for bootstrap ([c0187f2](https://github.com/myagentdojo/agent-plugin-template/commit/c0187f2b1cebefcee1e33c431d8ec22e5152fe06))
* **ci:** preserve canary SSH agent for bootstrap ([f23b77f](https://github.com/myagentdojo/agent-plugin-template/commit/f23b77f6c1a84f1b88e4b7ef371af864d706d70f))
* **ci:** remove Node 20 action warnings ([#4](https://github.com/myagentdojo/agent-plugin-template/issues/4)) ([857fc77](https://github.com/myagentdojo/agent-plugin-template/commit/857fc779bc485e85d5d88dbb54fc0d27ddb28819))
* correct command result interface documentation ([3f31de3](https://github.com/myagentdojo/agent-plugin-template/commit/3f31de39c712a70e2d9e5ad70ba47900d3330ccf))
* isolate native plugin hook adapters ([#3](https://github.com/myagentdojo/agent-plugin-template/issues/3)) ([b2aa2a8](https://github.com/myagentdojo/agent-plugin-template/commit/b2aa2a880e113b3ea2df35a829920351d530693a))
* **release:** clear first publication gates ([#13](https://github.com/myagentdojo/agent-plugin-template/issues/13)) ([7277f11](https://github.com/myagentdojo/agent-plugin-template/commit/7277f11dc72d616c82f73c4a356e37c683081a0e))
* support public and private template instances ([1b8ca9a](https://github.com/myagentdojo/agent-plugin-template/commit/1b8ca9ab0dacc999a5f78d3c1c75101623d0eba5))
* **test:** keep recipient suites reinitializable ([#8](https://github.com/myagentdojo/agent-plugin-template/issues/8)) ([fc91571](https://github.com/myagentdojo/agent-plugin-template/commit/fc91571153508a18b2a76e3f57ac8d4542ff67c9))


### Documentation

* add context and ADRs for plugin distribution ([3f31de3](https://github.com/myagentdojo/agent-plugin-template/commit/3f31de39c712a70e2d9e5ad70ba47900d3330ccf))
