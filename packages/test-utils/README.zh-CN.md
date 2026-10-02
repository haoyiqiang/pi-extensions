# @maplezzk/pi-test-utils

本 monorepo 测试使用的私有、确定性 fixture。

目前提供：

- 临时目录与 `PI_CODING_AGENT_DIR` 隔离；
- 扩展注册 harness，记录命令、工具、快捷键、flag、entry renderer、message renderer 和事件处理器的所有权；
- 组合扩展 smoke test 使用的即时冲突检测。

本包设置为 `private: true`，不会发布，也不能进入根 Pi 全量 profile。
