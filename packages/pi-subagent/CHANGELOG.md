# Changelog

## [1.1.0](https://github.com/haoyiqiang/pi-extensions/compare/pi-subagent-v1.0.0...pi-subagent-v1.1.0) (2026-10-31)


### Features

* **pi-subagent:** run subagents in detached tmux sessions with resumable history ([58d26fd](https://github.com/haoyiqiang/pi-extensions/commit/58d26fd927416b1b2c50f56f2ad86665b4ccc3f6))

## [1.0.0](https://github.com/haoyiqiang/pi-extensions/compare/pi-subagent-v0.1.0...pi-subagent-v1.0.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **pi-subagent:** make CLI output parseable for parent agents

### Features

* add panel-based pi-subagent ([b3f1f93](https://github.com/haoyiqiang/pi-extensions/commit/b3f1f9347b64e095e3d04eaf2536ae59914ab092))
* **pi-subagent:** add --auto-stop for one-shot runs ([d217c30](https://github.com/haoyiqiang/pi-extensions/commit/d217c30cc50d9e62c62f52780f13825b74b432af))
* **subagent:** add role preset config panel ([677a9df](https://github.com/haoyiqiang/pi-extensions/commit/677a9df14b9a13753a7e032ca3006c480dc3d31c))
* **subagent:** add role presets and harden lifecycle ([ca81afb](https://github.com/haoyiqiang/pi-extensions/commit/ca81afbd3efa404a5c863e3d9a56c33d3cebab0c))
* **subagent:** display bordered status widget above editor ([4946018](https://github.com/haoyiqiang/pi-extensions/commit/4946018bd20814a56df330a07590e4d0766fb3bc))


### Bug Fixes

* **pi-subagent:** collect auto-stop runs promptly and tolerate slow panel teardown ([93408ac](https://github.com/haoyiqiang/pi-extensions/commit/93408acd1d28c393dc65db8f0dc9f7665c36d46a))
* **subagent:** wait for resumed replies after interruption ([15c4387](https://github.com/haoyiqiang/pi-extensions/commit/15c43871a0caad47fcc694376c8f9bc4e56253e3))


### Reverts

* **pi-subagent:** drop --auto-stop ([b5d1d24](https://github.com/haoyiqiang/pi-extensions/commit/b5d1d24edb3e458a1a83a0112d7644e82ff95a1b))


### Code Refactoring

* **pi-subagent:** make CLI output parseable for parent agents ([b1efed4](https://github.com/haoyiqiang/pi-extensions/commit/b1efed473eb3f1922773441fe8dcd65c8603d24a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @kevinhao/pi-terminal-mux bumped from ^0.6.5 to ^0.7.0
