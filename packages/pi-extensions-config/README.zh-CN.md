# pi-extensions-config

供 Pi 扩展共享、无启动副作用的 JSON 配置读写库。

## 能力

- 解析 `PI_CODING_AGENT_DIR`，包括 `~` 与 `~/...`。
- 生成标准的 `<agent-dir>/extensions/<package>/config.json` 路径。
- 区分配置文件不存在、JSON 损坏和顶层不是对象。
- 使用原子替换写入格式化 JSON，并尽力设置 `0600` 权限。
- 提供保留其他字段的 read-modify-write 更新。
- 提供布尔保存接口，避免用户界面在写入失败时仍提示成功。

本包只负责配置的机械能力。字段 schema、默认值、环境变量优先级、旧配置迁移和设置界面仍由各功能扩展负责。

## 用法

```ts
import {
  extensionConfigPath,
  readJsonObject,
  updateJsonObjectAtomic,
} from "pi-extensions-config";

const path = extensionConfigPath("pi-example");
const current = readJsonObject(path) ?? {};

updateJsonObjectAtomic(path, (config) => {
  config.enabled = true;
});
```

这是纯库包，不注册 Pi 扩展、命令、工具或 UI。

本包的架构参考了 MIT 许可的 [`@juicesharp/rpiv-config`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-config)。当前实现面向 Pi agent 目录，保留“文件不存在”和“配置损坏”的区别，并使用原子替换写入。

## 许可证

[MIT](../../LICENSE)
