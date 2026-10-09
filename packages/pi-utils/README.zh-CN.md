# pi-utils

Pi 扩展的共享基础设施：

- 可移植的 JSON 配置读写（`src/config.ts`）；
- locale/catalog 运行时：支持 `zh-CN`、`en-US` 与 `auto`，并提供统一的带来源标签提示出口；
- 确定性的测试 fixture（`createExtensionRegistrationHarness`、临时目录隔离，以及 `pi-utils/rpiv` 的 Pi／UI／会话辅助）。

本包取代了原先的 `pi-extensions-config`、`pi-extensions-i18n` 和 `@maplezzk/pi-test-utils`。

## 安装

功能包会在运行时依赖 `pi-utils`，因此安装功能包即可获得语言命令与共享提示渲染器。只有需要单独使用语言命令时才直接安装：

```bash
pi install npm:pi-utils
```

安装后重新加载 Pi：

```text
/reload
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

## 本地化

- 支持 `zh-CN`、`en-US` 与 `auto` 三种偏好；
- 进程级 namespace registry 基于 `globalThis[Symbol.for(...)]`，同一进程内不同解析路径的包实例之间语言变更可以互通；
- 持久化位置为 `~/.pi/agent/extensions/pi-utils/config.json`；退役的 `~/.pi/agent/extensions/pi-extensions-i18n/config.json` 仍作为只读回退，下一次保存会写入新路径；
- `--locale` 启动参数与 `PI_EXTENSIONS_LOCALE` 环境变量覆盖；
- `/config:language` 交互命令、`/languages` 别名，以及 `/config:language en-US` 直接指定；
- 渲染时按 namespace 查询，缺省回退英文；`./loader` 子路径用于加载平铺的分语言文件；
- 兼容旧式 key-first 双语 catalog 的加载与校验，每个 key 必须同时包含两种语言；
- 供 UI、命令描述和 agent prompt 使用的插值翻译。

### 语言优先级

```text
--locale 启动参数
    > PI_EXTENSIONS_LOCALE 环境变量
    > 持久化配置（先 pi-utils，再退役的 pi-extensions-i18n 路径）
    > 默认 zh-CN
```

启动参数覆盖属于会话所有：子会话未传 `--locale` 时不会清掉根会话的覆盖，而是继承当前语言，除非显式绑定到另一个 owner。持久化偏好仍然共享。

`auto` 会依次检查 `LC_ALL`、`LC_MESSAGES`、`LANG`：中文系统 locale 解析为 `zh-CN`，其它解析为 `en-US`。同时接受 `zh`、`en` 简写。

扩展在解析启动参数或保存语言选择后会发出 `LOCALE_CHANGED_EVENT`（`pi-utils:i18n:locale:changed:v1`，`{ locale: "zh-CN" | "en-US" }`）。功能包可以借此重新注册自己的工具／命令描述。环境变量或外部编辑配置的兜底刷新应在 `session_start` 与输入／模型请求前进行，不要重置功能状态或自定义 guidance。

### namespace 与 catalog

注册 namespace 并在渲染时取词：

```ts
import { registerStrings, scope } from "pi-utils";

registerStrings("pi-example", {
  "en-US": { saved: "Saved" },
  "zh-CN": { saved: "已保存" },
});

const t = scope("pi-example");
t("saved", "Saved");
```

仓库内各包统一使用平铺的 `locales/en-US.json`、`locales/zh-CN.json`，并通过 `pi-utils/loader` 导出的 `registerLocalesFromDir` 注册。`createTranslator`、`getLocale`、`loadCatalog` 继续作为外部 key-first 双语 catalog 的兼容 API 保留，且每个 key 必须同时包含两种语言：

```json
{
  "description": {
    "zh-CN": "扩展描述",
    "en-US": "Extension description"
  }
}
```

非法 catalog 会在加载阶段直接失败，让漏翻在测试和 CI 中可见，而不是把单语言文案悄悄发给用户。

### 带来源标签的提示

所有用户可见提示都走 `notifyWithSource`：它把提示画成会话区里的实心底色块（与 Pi 的扩展消息同款），并在左侧标出来源短标签 `[tag]`。Pi 的 `info` 提示只是一行暗灰色文字，没有色块和标签就分不清是哪个扩展在说话。所有包共用同一个弱化标签色（`NOTICE_TAG_COLOR`）：来源靠标签文本区分，颜色刻意不承担识别职责。

```ts
import { NOTICE_TAG_COLOR, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-utils";

const NOTICE_TAG = "distill";
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

正文颜色跟随 `level`（warning 黄、error 红、info 用扩展消息正文色），`textColor` 可覆盖为自带语义色。TUI 模式下提示写成 Pi 自定义条目；rpc/print/json 仍走 `ctx.ui.notify` 的纯文本 `[distill] message`，不会把 ANSI 泄漏到其它前端。细节行默认收起在一行内，行尾用方向箭头表示可展开（收起 `▶`、展开 `▼`）：全屏模式点击提示块，常规模式按 `Ctrl+O`。没有细节行的提示不带箭头。

底色块由本包的扩展入口注册一次。功能包应发布一个内容为 `export { default } from "pi-utils"` 的 `i18n-entry.ts`，并在 `pi.extensions` 中放在自身入口之前。通过正常依赖解析兼容 scoped、提升和嵌套 npm 布局，不依赖工作区 sibling 路径。同一运行时 event bus 内只注册一次，独立子会话仍分别初始化。只需要渲染字符串时可使用 `formatNotice({ source, message, mode, theme })`。

提示的写入 owner 绑定在稳定的 `ctx.sessionManager` 上，而不是进程里最后加载的扩展 API。对于精简 UI 视图或需要把提示转发给父会话的子会话：

```ts
import { bindNoticeOwner, getNoticeOwnerBinding } from "pi-utils";

const release = bindNoticeOwner(view, getNoticeOwnerBinding(parentCtx));
// 之后 notifyWithSource({ ctx: view, ... }) 会写入显式继承的父会话出口。
release();
```

绑定带 token 保护：根会话关闭或替换后旧 relay 会失效，退回自己的 UI，而不会写进已关闭／已替换的会话。只安装 renderer 不会认领提示 owner。

## 测试 fixture

确定性的 monorepo 测试辅助也放在本包：

- `withTempDir` 与 `withTempAgentDir` 隔离临时目录和 `PI_CODING_AGENT_DIR`；
- `createExtensionRegistrationHarness` 记录命令、工具、快捷键、flag、entry renderer、message renderer 和事件处理器的所有权，遇到注册冲突立即抛错；
- `pi-utils/rpiv` 提供适配自上游的 Pi／UI／会话／manifest fixture，MIT 归属保留于 `RPIV-LICENSE`。

这些是测试专用接口，产品包只在测试文件中引用。

## 要求

- Node.js 22 或更高版本；
- 使用语言命令或提示渲染器时需要 Pi 扩展运行时。

## License

[MIT](../../LICENSE)
