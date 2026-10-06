/**
 * 用户可见提示的统一呈现：把提示画成会话区里的「带底色消息块」，并标出来源扩展。
 *
 * 背景：Pi 的 ui.notify(info) 只是一行暗灰色文字（warning/error 才有黄色/红色前缀），
 * 各扩展全用 info 时用户在会话里既分不清来源，也分不清哪条是提示。
 *
 * 做法：提示改走 Pi 的自定义条目（appendEntry + registerEntryRenderer），
 * 渲染成和用户消息同款的实心底色块（主题色 customMessageBg），左侧标注来源扩展的短标签。
 * 细节行（details）默认收起：行尾用方向箭头（收起态 `▶`、展开态 `▼`）表示这里能展开，
 * 全屏模式下直接点这条提示块即可切换。
 * 这些条目不进入 LLM 上下文，只影响会话区外观。
 *
 * 为什么用箭头而不是「Ctrl+O 展开」：全屏模式与常规模式在渲染时区分不出来（Pi 没把
 * tuiMode 交给条目渲染器），而箭头在两种模式下都成立 —— 它说的是「这里有东西可以展开」，
 * 不承诺具体按键；`Ctrl+O` 这个键 Pi 自己的工具行一直在教。
 *
 * 本模块只用结构化类型，不直接依赖 Pi 的实现，便于独立测试。
 */
import * as piTui from "@earendil-works/pi-tui";

/** 允许使用的提示级别；同时是运行时校验的唯一真值来源。 */
const NOTICE_LEVELS = ["info", "warning", "error"] as const;

/** 提示级别，与 Pi 的 ui.notify 类型一致。 */
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];

/** 允许使用的主题色名（Pi 主题色的子集）；同时是运行时校验的唯一真值来源。 */
const NOTICE_COLORS = [
  "accent",
  "success",
  "warning",
  "error",
  "muted",
  "dim",
  "text",
  "customMessageText",
  "toolTitle",
] as const;

/** 提示用到的主题色名。 */
export type NoticeColor = (typeof NOTICE_COLORS)[number];

/**
 * 提示来源标签的统一颜色。
 *
 * 标签只负责标出来源（文本已经说清了是谁），不负责区分来源 —— 9 个色槽分给
 * 扩展数量超过主题色槽后必然撞车，一旦撞车颜色就不再有定位价值，反而会误导来源判断。
 * 参考 Codex / Claude Code / Gemini CLI / lazygit / k9s 等 TUI：没有谁用颜色标注来源。
 */
export const NOTICE_TAG_COLOR: NoticeColor = "muted";

/** 一个扩展的提示来源：短标签 + 统一颜色。 */
export interface NoticeSource {
  /** 展示在消息前的短标签，例如 "naming"。建议用包名去掉 pi- 前缀。 */
  tag: string;
  /** 标签颜色；所有扩展统一用 NOTICE_TAG_COLOR，来源靠 tag 文本区分。 */
  color: NoticeColor;
}

/** 渲染提示所需的最小 UI 上下文。 */
export interface NoticeOwnerContext {
  /** Pi 同一会话内稳定的 session manager；事件 ctx 自身会按事件重建，不能拿来标识会话。 */
  sessionManager?: object;
}

export interface NoticeContext extends NoticeOwnerContext {
  /** 运行模式；只有 tui 会渲染成带底色的消息块。 */
  mode?: string;
  ui: {
    /** Pi 的提示出口；非 TUI 模式仍走这里。 */
    notify(message: string, type?: NoticeLevel): void;
    /** 主题；缺失时不加颜色。 */
    theme?: { fg(color: NoticeColor, text: string): string };
  };
}

/** 一次提示的渲染输入。 */
export interface NoticeRenderOptions {
  /** 来源标签与颜色。 */
  source: NoticeSource;
  /** 提示正文（已本地化）。 */
  message: string;
  /** 运行模式；非 tui 时输出纯文本。 */
  mode: string | undefined;
  /** 主题；缺失时输出纯文本。 */
  theme: NoticeContext["ui"]["theme"];
}

/** 一次带来源的提示调用。 */
export interface NoticeSendOptions {
  /** 目标 UI 上下文；运行模式与主题从它上面读取。 */
  ctx: NoticeContext;
  /** 来源标签与颜色。 */
  source: NoticeSource;
  /** 提示级别；决定正文颜色（warning 黄、error 红、info 用正文色）。 */
  level: NoticeLevel;
  /** 提示正文（已本地化）。 */
  message: string;
  /** 正文颜色覆盖；例如判定结论行自带语义色（dim/success）时用它。 */
  textColor?: NoticeColor;
  /** 展开时才显示的细节行，平时只占一行，避免刷屏。 */
  details?: string[];
}

/** 只有 TUI 模式能安全地看到 ANSI 颜色。 */
export const NOTICE_COLOR_MODE = "tui";

/** 来源标签与提示正文之间的分隔符。 */
const TAG_SEPARATOR = " ";
/** 收起态的展开箭头：实心右三角，与清爽模式的折叠头用同一个字形。 */
const COLLAPSED_ARROW = "▶";
/** 展开态的收起箭头。 */
const EXPANDED_ARROW = "▼";
/** 正文与末尾箭头之间的间距。 */
const HINT_SEPARATOR = " ";
/** 提示条目的类型名；所有扩展共用一种，渲染器只需注册一次。 */
export const NOTICE_ENTRY_TYPE = "pi-extensions-notice";

/** 提示块的底色主题色：和 Pi 的扩展消息同款，视觉效果接近输入框。 */
export const NOTICE_BACKGROUND_COLOR = "customMessageBg";

/** 落进会话的提示条目数据；渲染器只依赖这些字段，重启后也能原样重建。 */
export interface NoticeEntryData {
  /** 来源短标签。 */
  tag: string;
  /** 标签颜色。 */
  color: NoticeColor;
  /** 提示级别；决定正文默认颜色。 */
  level: NoticeLevel;
  /** 提示正文。 */
  message: string;
  /** 正文颜色覆盖。 */
  textColor?: NoticeColor;
  /** 展开时才显示的细节行（Ctrl+O 展开工具输出时一起展开）。 */
  details?: string[];
}

/** 渲染器拿到的主题：只需要前景色与底色。 */
export interface NoticeEntryTheme {
  /** 前景色。 */
  fg(color: NoticeColor, text: string): string;
  /** 底色。 */
  bg(color: typeof NOTICE_BACKGROUND_COLOR, text: string): string;
}

/** 提示渲染所需的 Pi 能力：写入自定义条目 + 注册条目渲染器。 */
export interface NoticeApi {
  /** 追加一条不进 LLM 上下文的自定义条目。 */
  appendEntry(customType: string, data?: unknown): void;
  /** 注册自定义条目的 TUI 渲染器；Pi 会把展开状态一起传进来。 */
  registerEntryRenderer(
    customType: string,
    renderer: (
      entry: { data?: unknown },
      options: { expanded?: boolean },
      theme: NoticeEntryTheme,
    ) => piTui.Component,
  ): void;
}

/**
 * 一个可显式转接的提示写入 owner。
 *
 * SDK/子会话若要把提示明确 relay 到父会话，应从父 ctx 读取这个 binding，
 * 再把它绑定到 relay ctx；不需要读取任何产品包私有 Symbol。
 */
export interface NoticeOwnerBinding {
  /** 把一条提示写入这个 owner 所属的会话。 */
  appendNotice(data: NoticeEntryData): void;
}

/** 解除一次 owner 绑定；重复调用安全，且不会误删后来替换它的绑定。 */
export type NoticeOwnerRelease = () => void;

/** 判断一个未知值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 运行时校验主题色名。 */
function isNoticeColor(value: unknown): value is NoticeColor {
  return typeof value === "string" && NOTICE_COLORS.some((color) => color === value);
}

/** 运行时校验提示级别。 */
function isNoticeLevel(value: unknown): value is NoticeLevel {
  return typeof value === "string" && NOTICE_LEVELS.some((level) => level === value);
}

/**
 * 提示运行时只保存「会话 owner → 写入 binding」映射，不保存 latest API。
 *
 * Pi 会为每个事件创建新的 ctx，但同一会话的 sessionManager 稳定，因此 owner 以
 * sessionManager 为键。多个原生 Pi runtime 共处一个进程时也不会因 factory 执行顺序
 * 把父会话出口替换成最后加载的子会话 API。
 */
const NOTICE_RUNTIME_KEY = Symbol.for("pi-extensions-i18n.notice-runtime.v2");

interface NoticeOwnerRegistration {
  token: object;
  binding: NoticeOwnerBinding;
  /** 只在本 registration 仍是 source owner 时可写的公开 lease。 */
  lease: NoticeOwnerBinding;
}

interface NoticeRuntime {
  bindings: WeakMap<object, NoticeOwnerBinding>;
  owners: WeakMap<object, NoticeOwnerRegistration>;
  registeredApis: WeakSet<object>;
  rendererInstalled: boolean;
}

function createNoticeRuntime(): NoticeRuntime {
  return {
    bindings: new WeakMap(),
    owners: new WeakMap(),
    registeredApis: new WeakSet(),
    rendererInstalled: false,
  };
}

function noticeRuntime(): NoticeRuntime {
  const global = globalThis as unknown as { [NOTICE_RUNTIME_KEY]?: NoticeRuntime };
  if (!global[NOTICE_RUNTIME_KEY]) {
    global[NOTICE_RUNTIME_KEY] = createNoticeRuntime();
  }
  return global[NOTICE_RUNTIME_KEY];
}

/** 取同一会话稳定的 owner key；简化测试上下文没有 sessionManager 时退回 ctx 本身。 */
function noticeOwnerKey(ctx: NoticeOwnerContext): object {
  try {
    if (typeof ctx.sessionManager === "object" && ctx.sessionManager !== null) {
      return ctx.sessionManager;
    }
  } catch {
    // 旧 runtime 已关闭时 guarded getter 可能抛错；退回 ctx，让提示走 notify fallback。
  }
  return ctx;
}

/** 提示块的水平内边距：让文字不贴边。 */
const NOTICE_PADDING_X = 1;
/** 提示块的垂直内边距：0 表示只占一行，避免提示刷屏。 */
const NOTICE_PADDING_Y = 0;

/**
 * 注册提示条目渲染器，并返回该 API 的写入 binding。
 *
 * 注册 renderer 与选择当前会话写入 owner 是两步：本函数不会把 API 设成进程级 latest，
 * 调用方应在 session_start 用 bindNoticeOwner() 绑定真实 ctx，并在 session_shutdown 释放。
 * 老版本 Pi 没有这两个能力时返回 undefined，提示会退回 ui.notify。
 */
export function installNoticeRenderer(api: NoticeApi): NoticeOwnerBinding | undefined {
  if (typeof api.appendEntry !== "function" || typeof api.registerEntryRenderer !== "function") {
    return undefined;
  }
  const runtime = noticeRuntime();
  if (!runtime.registeredApis.has(api as object)) {
    api.registerEntryRenderer(NOTICE_ENTRY_TYPE, (entry, options, theme) =>
      renderNoticeEntry(entry, theme, isExpanded(options)));
    runtime.registeredApis.add(api as object);
  }
  runtime.rendererInstalled = true;

  let binding = runtime.bindings.get(api as object);
  if (binding === undefined) {
    binding = Object.freeze({
      appendNotice: (data: NoticeEntryData) => api.appendEntry(NOTICE_ENTRY_TYPE, data),
    });
    runtime.bindings.set(api as object, binding);
  }
  return binding;
}

/**
 * 把一个 ctx/session 明确绑定到提示 owner。
 *
 * 返回的 cleanup 由本次 token 持有：旧 runtime 较晚清理时，如果同一 session 已由新
 * runtime 接管，它不会删除新 binding。
 */
export function bindNoticeOwner(
  ctx: NoticeOwnerContext,
  binding: NoticeOwnerBinding | undefined,
): NoticeOwnerRelease {
  if (binding === undefined) return () => {};
  const runtime = noticeRuntime();
  const key = noticeOwnerKey(ctx);
  const token = {};
  const registration: NoticeOwnerRegistration = {
    token,
    binding,
    lease: Object.freeze({
      appendNotice: (data: NoticeEntryData) => {
        if (runtime.owners.get(key)?.token !== token) {
          throw new Error("notice owner is no longer active");
        }
        binding.appendNotice(data);
      },
    }),
  };
  runtime.owners.set(key, registration);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (runtime.owners.get(key)?.token === registration.token) {
      runtime.owners.delete(key);
    }
  };
}

/**
 * 读取 ctx 当前所属的 owner lease，供 SDK UI relay 显式继承父会话出口。
 * source owner 被 release 或 replacement 后，该 lease 会拒绝继续写旧会话。
 */
export function getNoticeOwnerBinding(ctx: NoticeOwnerContext): NoticeOwnerBinding | undefined {
  return noticeRuntime().owners.get(noticeOwnerKey(ctx))?.lease;
}

/** 当前是否已安装 renderer；传 ctx 时进一步检查该会话是否已有写入 owner。 */
export function hasNoticeRenderer(ctx?: NoticeOwnerContext): boolean {
  return ctx === undefined
    ? noticeRuntime().rendererInstalled
    : getNoticeOwnerBinding(ctx) !== undefined;
}

/** 测试与重载用：清掉 renderer 注册记录与 owner 映射。 */
export function resetNoticeRenderer(): void {
  const global = globalThis as unknown as { [NOTICE_RUNTIME_KEY]?: NoticeRuntime };
  global[NOTICE_RUNTIME_KEY] = createNoticeRuntime();
}

/** 正文默认颜色：warning 黄、error 红、info 用扩展消息正文色。 */
export function noticeBodyColor(level: NoticeLevel, textColor?: NoticeColor): NoticeColor {
  if (textColor !== undefined) return textColor;
  if (level === "warning") return "warning";
  if (level === "error") return "error";
  return "customMessageText";
}

/**
 * 把未知的条目数据收敛成提示条目数据。
 * 逐字段运行时校验；缺失或类型不符时给出可读兜底，不信任外来数据。
 */
function readNoticeEntryData(input: unknown): NoticeEntryData {
  const raw = isRecord(input) && isRecord(input.data) ? input.data : {};
  const tag = typeof raw.tag === "string" && raw.tag !== "" ? raw.tag : "notice";
  const message = typeof raw.message === "string" ? raw.message : "";
  return {
    tag,
    color: isNoticeColor(raw.color) ? raw.color : "muted",
    level: isNoticeLevel(raw.level) ? raw.level : "info",
    message,
    textColor: isNoticeColor(raw.textColor) ? raw.textColor : undefined,
    details: readDetails(raw.details),
  };
}

/** 只保留非空字符串细节行，避免渲染出空气泡。 */
function readDetails(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is string => typeof line === "string" && line.trim() !== "");
  return lines.length > 0 ? lines : undefined;
}

/** 判断渲染器是否处于展开状态（Ctrl+O）；缺省视为收起。 */
function isExpanded(options: unknown): boolean {
  return isRecord(options) && options.expanded === true;
}

/** 鼠标事件类型：只有左键 click 才切换展开态。 */
const MOUSE_EVENT_CLICK = "click";
/** 鼠标按键：只响应左键。 */
const MOUSE_BUTTON_LEFT = "left";

/** 鼠标事件里用得上的字段；只做结构化读取，不依赖 pi-tui 的具体类型。 */
interface NoticeMouseEvent {
  type?: unknown;
  button?: unknown;
}

/** MouseRegion 的最小结构类型：包住子组件、接管它的鼠标事件。 */
type NoticeMouseRegion = new (
  child: piTui.Component,
  onMouse: (event: NoticeMouseEvent) => { handled?: boolean } | undefined,
) => piTui.Component;

/**
 * 取 pi-tui 的 MouseRegion。
 * 只有全屏模式才会把鼠标事件派发到条目上；老版本 pi-tui 没有这个导出时返回 undefined，
 * 提示块保持不可点击，键盘展开（Ctrl+O）照常可用。
 */
function resolveMouseRegion(): NoticeMouseRegion | undefined {
  const candidate: unknown = (piTui as { MouseRegion?: unknown }).MouseRegion;
  return typeof candidate === "function" ? (candidate as NoticeMouseRegion) : undefined;
}

/**
 * 组装行尾的展开箭头；没有细节行时返回空串。
 *
 * 用强调色而不是正文色：正文可能是 dim（未判定类结论），箭头得看得出是个可点的标记，
 * 不能被静默成正文的一部分。
 */
function buildExpandArrow(data: NoticeEntryData, theme: NoticeEntryTheme, expanded: boolean): string {
  if (data.details === undefined) return "";
  return `${HINT_SEPARATOR}${theme.fg("accent", expanded ? EXPANDED_ARROW : COLLAPSED_ARROW)}`;
}

/** 构造带底色的提示块正文；有细节行时在行尾标出展开方向，展开后追加细节行。 */
function buildNoticeBox(input: unknown, theme: NoticeEntryTheme, expanded: boolean): piTui.Component {
  const data = readNoticeEntryData(input);
  const label = theme.fg(data.color, `[${data.tag}]`);
  const body = theme.fg(noticeBodyColor(data.level, data.textColor), data.message);
  const arrow = buildExpandArrow(data, theme, expanded);
  const box = new piTui.Box(NOTICE_PADDING_X, NOTICE_PADDING_Y, (text) => theme.bg(NOTICE_BACKGROUND_COLOR, text));
  box.addChild(new piTui.Text(`${label}${TAG_SEPARATOR}${body}${arrow}`, 0, 0));
  if (expanded && data.details !== undefined) {
    for (const line of data.details) {
      box.addChild(new piTui.Text(theme.fg("dim", line), 0, 0));
    }
  }
  return box;
}

/**
 * 提示块的正文组件。
 *
 * 展开态存在实例上，和 Pi 自己的工具输出组件一个做法：点击后宿主只请求重画、
 * 不重建组件，所以 render() 时读实例状态就够。
 */
class NoticeEntryBody implements piTui.Component {
  /** 点击带来的本地覆盖；undefined 表示跟随全局 Ctrl+O。 */
  private override?: boolean;
  /** 缓存的渲染结果：键是当时用的展开态。 */
  private cached?: { expanded: boolean; box: piTui.Component };

  /**
   * @param input 条目数据（细节行写在 details 里）
   * @param theme 前景色与底色
   * @param globalExpanded 宿主给的全局展开态（Ctrl+O）
   */
  constructor(
    private readonly input: unknown,
    private readonly theme: NoticeEntryTheme,
    private readonly globalExpanded: boolean,
  ) {}

  /** 当前是否展开：本地点击覆盖优先，没点过就跟随全局 Ctrl+O。 */
  private isExpanded(): boolean {
    return this.override ?? this.globalExpanded;
  }

  /** 点击时翻转展开态，返回翻转后的状态。 */
  toggle(): boolean {
    this.override = !this.isExpanded();
    return this.override;
  }

  /** 按当前展开态渲染；只在展开态变化时重建内部组件树。 */
  render(width: number): string[] {
    const expanded = this.isExpanded();
    if (this.cached === undefined || this.cached.expanded !== expanded) {
      this.cached = { expanded, box: buildNoticeBox(this.input, this.theme, expanded) };
    }
    return this.cached.box.render(width);
  }

  /** 转发失效通知，让内部组件树下次重新渲染。 */
  invalidate(): void {
    this.cached?.box.invalidate();
  }
}

/**
 * 把一个提示条目渲染成带底色的消息块。
 *
 * 默认只占一行（上下不加空白），避免提示刷屏；有细节行时行尾带展开箭头，
 * 细节行只在展开时追加：全屏模式下直接点这条提示块切换，常规模式用 Ctrl+O。
 * 这里直接构造 pi-tui 的 Box/Text：带底色消息块的排版（整块铺底色、按宽度换行）
 * 由 pi-tui 提供，Pi 自带的扩展消息渲染也是同样写法，属于有意为之的绑定。
 */
export function renderNoticeEntry(
  input: unknown,
  theme: NoticeEntryTheme,
  expanded = false,
): piTui.Component {
  const body = new NoticeEntryBody(input, theme, expanded);
  const MouseRegion = resolveMouseRegion();
  // 没有细节行、或 pi-tui 太老没有 MouseRegion 时就不接管点击，只保留键盘展开。
  if (MouseRegion === undefined || readNoticeEntryData(input).details === undefined) return body;
  return new MouseRegion(body, (event) => {
    if (event.type !== MOUSE_EVENT_CLICK || event.button !== MOUSE_BUTTON_LEFT) return undefined;
    body.toggle();
    return { handled: true };
  });
}

/**
 * 给提示文本加上来源标签与颜色。
 * 非 TUI 模式或没有主题时返回纯文本，避免把 ANSI 序列转发给前端。
 */
export function formatNotice(options: NoticeRenderOptions): string {
  const { source, message, mode, theme } = options;
  const tag = `[${source.tag}]`;
  if (mode !== NOTICE_COLOR_MODE || theme === undefined) return `${tag}${TAG_SEPARATOR}${message}`;
  return `${theme.fg(source.color, tag)}${TAG_SEPARATOR}${message}`;
}

/**
 * 统一的提示出口。
 *
 * TUI：写一条自定义条目，由 registerEntryRenderer 画成带底色的消息块。
 * 其它模式（RPC/print/json）：仍走 ui.notify，行为与改造前一致。
 * 条目写入失败时退回 ui.notify，保证提示不会因为渲染方式而丢失。
 */
export function notifyWithSource(options: NoticeSendOptions): void {
  const { ctx, source, level, message, textColor, details } = options;
  const noticeOwner = getNoticeOwnerBinding(ctx);
  if (ctx.mode === NOTICE_COLOR_MODE && noticeOwner !== undefined) {
    const data: NoticeEntryData = {
      tag: source.tag,
      color: source.color,
      level,
      message,
      textColor,
      details,
    };
    try {
      noticeOwner.appendNotice(data);
      return;
    } catch {
      // owner 已关闭或会话不可写时落到 ui.notify；绝不改投其它会话。
    }
  }
  const text = formatNotice({ source, message, mode: ctx.mode, theme: ctx.ui.theme });
  ctx.ui.notify(text, level);
}
