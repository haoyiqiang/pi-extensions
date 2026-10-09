# pi-utils

Pi 扩展的共享基础设施：

- 可移植的 JSON 配置读写（`src/config.ts`）；
- 确定性的测试 fixture（`createExtensionRegistrationHarness`、临时目录隔离，以及 `pi-utils/rpiv` 的 Pi／UI／会话辅助）。

本包取代了原先的 `pi-extensions-config`、`pi-extensions-i18n` 和 `@maplezzk/pi-test-utils`。

## 安装

本包是 npm 工具库，不是 Pi 扩展。功能包直接依赖它。不要把它写进 Pi 扩展清单，也不要用 `pi install` 安装。

```bash
npm install pi-utils
```

## 配置读写

`src/config.ts` 只负责配置机制；功能 schema、默认值、环境变量优先级、迁移和设置界面仍由各扩展自己负责。

- 解析 `PI_CODING_AGENT_DIR`，支持 `~` 与 `~/...` 形式；
- 拼出约定路径 `<agent-dir>/extensions/<package>/config.json`；
- 区分「文件不存在」与「JSON 损坏 / 非对象」两种情况；
- 原子写入格式化 JSON，并尽力设置 `0600` 权限；
- 保留式 read-modify-write，更新时不会丢掉兄弟字段；
- 提供布尔保存包装，避免面向用户的命令把失败写入报告成成功。

```ts
import {
  extensionConfigPath,
  readJsonObject,
  updateJsonObjectAtomic,
} from "pi-utils";

const path = extensionConfigPath("pi-example");
const current = readJsonObject(path) ?? {};

updateJsonObjectAtomic(path, (config) => {
  config.enabled = true;
});
```

## 文案

用户可见文案由各功能包用英文直接写在代码里。`pi-utils` 不负责语言选择，不渲染提示，也不作为 Pi 扩展加载。功能包直接调用 `ctx.ui.notify`。

## 测试 fixture

确定性的 monorepo 测试辅助也放在本包：

- `withTempDir` 与 `withTempAgentDir` 隔离临时目录和 `PI_CODING_AGENT_DIR`；
- `createExtensionRegistrationHarness` 记录命令、工具、快捷键、flag、entry renderer、message renderer 和事件处理器的所有权，遇到注册冲突立即抛错；
- `pi-utils/rpiv` 提供适配自上游的 Pi／UI／会话／manifest fixture，MIT 归属保留于 `RPIV-LICENSE`。

这些是测试专用接口，产品包只在测试文件中引用。

## 要求

- Node.js 22 或更高版本。

## License

[MIT](../../LICENSE)
