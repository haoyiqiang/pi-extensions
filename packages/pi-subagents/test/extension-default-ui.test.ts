import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as configIO from "pi-extensions-config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import productExtension from "../index.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { i18n } from "../src/i18n.js";
import { describeAgentExtensionPolicy, describeExtensionSource, readDefaultExtensionPolicy } from "../src/ui/extension-default-policy.js";
import { ctx as makeContext, hermeticDir, makePi } from "./helpers/boot-extension.js";

beforeAll(() => initTheme(undefined, false));
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const down = "\u001b[B";

function makeUIPi() {
  const h = makePi();
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>();
  h.pi.on.mockImplementation((event: string, handler: (...args: any[]) => unknown) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    h.lifecycle.set(event, async (...args: any[]) => {
      for (const listener of [...set]) await listener(...args);
    });
    return () => set.delete(handler);
  });
  return h;
}

async function drive(options: {
  project?: Record<string, unknown>;
  global?: Record<string, unknown>;
  mode?: "all" | "specified" | "none" | "reset";
  keys?: string[];
  revokeTrust?: boolean;
  failSave?: boolean;
  spaceOnly?: boolean;
  wraparound?: boolean;
}) {
  const env = hermeticDir({ settings: { schedulingEnabled: false, ...options.project } });
  const h = makeUIPi();
  let trusted = true;
  const ctx = makeContext({ cwd: env.dir, hasUI: true, isProjectTrusted: () => trusted });
  const projectPath = join(env.dir, ".pi/subagents.json");
  const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "subagents.json");
  const globalText = JSON.stringify(options.global ?? { defaultExtensions: ["global-only"], futureGlobal: 1 });
  writeFileSync(globalPath, globalText);
  const pkg = join(process.env.PI_CODING_AGENT_DIR!, "extensions/current-tools");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "index.ts"), "throw new Error('never import catalog candidates');");
  const before = readFileSync(projectPath, "utf8");
  let originalRaw: unknown;
  const selections = [i18n.t("product.menuSettings"), options.mode ? i18n.t(`extensionDefaults.${options.mode}`) : undefined];
  ctx.ui.select = vi.fn(async () => selections.shift());
  let calls = 0;
  let reopenedDefaultsSelected = false;
  const rendered: string[] = [];
  ctx.ui.custom = vi.fn(async (factory: any) => {
    const call = calls++;
    let result: unknown;
    const component = factory({ requestRender: vi.fn() }, theme, {}, (value: unknown) => { result = value; });
    if (call === 0) {
      if (options.wraparound) {
        component.handleInput("\u001b[A"); // First → last.
        component.handleInput(down); // Last → first.
      }
      component.handleInput(down); // Backend must remain first; defaults is second.
      component.handleInput(" "); // No writes/cycling on this row.
      component.handleInput("\u001b[13;1:3u"); // Kitty Enter release must not activate it.
      expect(ctx.ui.select).toHaveBeenCalledTimes(1);
      expect(readFileSync(projectPath, "utf8")).toBe(before);
      expect(h.pi.events.emit.mock.calls.some((call: any[]) => call[0] === "subagents:settings_changed")).toBe(false);
      if (options.spaceOnly) component.handleInput("\u001b");
      else component.handleInput("\r");
    } else if (options.mode === "specified" && call === 1) {
      for (const key of options.keys ?? ["\r"]) component.handleInput(key);
      if (options.revokeTrust) trusted = false;
    } else {
      reopenedDefaultsSelected = component.render(1000).join("\n").includes(i18n.t("extensionDefaults.description", {
        source: describeExtensionSource(readDefaultExtensionPolicy(env.dir, trusted)),
      }));
      component.handleInput("\u001b");
    }
    rendered.push(...component.render(180));
    return result;
  });
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    productExtension(h.pi);
    await h.lifecycle.get("session_start")({}, ctx);
    originalRaw = getAgentConfig("general-purpose")?.extensions;
    h.pi.events.emit.mockClear();
    if (options.failSave) spy = vi.spyOn(configIO, "updateJsonObjectAtomic").mockImplementationOnce(() => { throw new Error("atomic save blocked"); });
    await h.commands.get("config:subagents")!.handler("", ctx);
    expect(getAgentConfig("general-purpose")?.extensions).toBe(originalRaw);
    expect(readFileSync(globalPath, "utf8")).toBe(globalText);
    return {
      before, after: readFileSync(projectPath, "utf8"),
      policy: readDefaultExtensionPolicy(env.dir, trusted),
      events: h.pi.events.emit.mock.calls.filter((call: any[]) => call[0] === "subagents:settings_changed"),
      notices: ctx.ui.notify.mock.calls,
      rendered: rendered.join("\n"),
      customCalls: calls,
      reopenedDefaultsSelected,
    };
  } finally {
    spy?.mockRestore();
    await h.lifecycle.get("session_shutdown")?.({ reason: "quit" });
    registerAgents(new Map());
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    env.restore();
  }
}

describe("default extension project panel", () => {
  it("does not persist display labels on Space or key releases", async () => {
    const result = await drive({ spaceOnly: true });
    expect(result.after).toBe(result.before);
    expect(result.events).toEqual([]);
    expect(result.customCalls).toBe(1);
  });

  it.each([undefined, [] as string[]])("keeps default provenance when another setting is saved (%j)", async projectDefault => {
    const project = projectDefault === undefined ? {} : { defaultExtensions: projectDefault };
    const env = hermeticDir({ settings: { schedulingEnabled: false, showCost: false, ...project } });
    const h = makeUIPi();
    const ctx = makeContext({ cwd: env.dir, hasUI: true });
    const globalPath = join(process.env.PI_CODING_AGENT_DIR!, "subagents.json");
    const globalText = '{"defaultExtensions":["global-only"],"futureGlobal":1}';
    writeFileSync(globalPath, globalText);
    ctx.ui.select = vi.fn().mockResolvedValueOnce(i18n.t("product.menuSettings"));
    ctx.ui.custom = vi.fn(async (factory: any) => {
      const component = factory({ requestRender: vi.fn() }, theme, {}, vi.fn());
      let found = false;
      for (let index = 0; index < 50; index++) {
        if (component.render(2000).join("\n").includes(i18n.t("product.showCostDescription"))) {
          found = true;
          break;
        }
        component.handleInput(down);
      }
      expect(found).toBe(true);
      component.handleInput(" ");
      component.handleInput("\u001b");
      return undefined;
    });
    try {
      productExtension(h.pi);
      await h.lifecycle.get("session_start")({}, ctx);
      await h.commands.get("config:subagents")!.handler("", ctx);
      const saved = JSON.parse(readFileSync(join(env.dir, ".pi/subagents.json"), "utf8"));
      expect(saved.showCost).toBe(true);
      expect(Object.hasOwn(saved, "defaultExtensions")).toBe(projectDefault !== undefined);
      expect(saved.defaultExtensions).toEqual(projectDefault);
      expect(readDefaultExtensionPolicy(env.dir, true)).toMatchObject({
        value: projectDefault ?? ["global-only"], source: projectDefault === undefined ? "global" : "project",
      });
      expect(readFileSync(globalPath, "utf8")).toBe(globalText);
    } finally {
      await h.lifecycle.get("session_shutdown")?.({ reason: "quit" });
      registerAgents(new Map());
      delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
      env.restore();
    }
  });

  it("cancels both mode selection and picker draft without writes or broadcasts", async () => {
    const cancelledMode = await drive({});
    expect(cancelledMode.after).toBe(cancelledMode.before);
    expect(cancelledMode.events).toEqual([]);
    const cancelledPicker = await drive({ mode: "specified", keys: [" ", "\u001b"] });
    expect(cancelledPicker.after).toBe(cancelledPicker.before);
    expect(cancelledPicker.events).toEqual([]);
    expect(cancelledPicker.customCalls).toBe(3); // Settings reopens after cancel.
    expect(cancelledPicker.reopenedDefaultsSelected).toBe(true);
  });

  it("keeps Enter aligned with native Settings wraparound selection", async () => {
    const result = await drive({ mode: "none", wraparound: true });
    expect(JSON.parse(result.after).defaultExtensions).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.reopenedDefaultsSelected).toBe(true);
  });

  it("preserves unrelated fields, unknown saved selectors and global bytes", async () => {
    const result = await drive({ mode: "specified", project: {
      defaultExtensions: ["unknown-saved"], backend: "embedded", futureProductKey: { nested: true },
    } });
    expect(JSON.parse(result.after)).toMatchObject({ defaultExtensions: ["unknown-saved"], backend: "embedded", futureProductKey: { nested: true } });
    expect(result.events).toHaveLength(1);
    expect(result.events[0][1]).toMatchObject({ persisted: true, settings: { defaultExtensions: ["unknown-saved"] } });
    expect(result.rendered).toContain(i18n.t("extensionDefaults.unavailable"));
  });

  it("saves an empty explicit selection and distinguishes all-current from future-inclusive all", async () => {
    const none = await drive({ mode: "specified", keys: ["\u0012", "\r"] });
    expect(JSON.parse(none.after).defaultExtensions).toEqual([]);
    const current = await drive({ mode: "specified", keys: ["\u0012", "\u0001", "\r"] });
    expect(JSON.parse(current.after).defaultExtensions).toEqual(["current-tools"]);
    const all = await drive({ mode: "all" });
    expect(JSON.parse(all.after).defaultExtensions).toBe(true);
    const disabled = await drive({ mode: "none" });
    expect(JSON.parse(disabled.after).defaultExtensions).toBe(false);
  });

  it("resets only the project key and reveals global provenance", async () => {
    const result = await drive({ mode: "reset", project: { defaultExtensions: false, futureProductKey: 42 } });
    expect(JSON.parse(result.after)).toEqual({ schedulingEnabled: false, futureProductKey: 42 });
    expect(result.policy).toMatchObject({ value: ["global-only"], source: "global" });
    expect(result.events[0][1].settings.defaultExtensions).toEqual(["global-only"]);
    expect(result.rendered).toContain(i18n.t("extensionDefaults.global"));
  });

  it("rechecks trust after picker confirmation and does not fall back to global writes", async () => {
    const result = await drive({ mode: "specified", keys: ["\u0012", "\r"], revokeTrust: true });
    expect(result.after).toBe(result.before);
    expect(result.events).toEqual([]);
    expect(result.notices.some((call: any[]) => call[0].includes(i18n.t("product.projectUntrusted")))).toBe(true);
  });

  it("reports atomic failures without applying or broadcasting the draft", async () => {
    const result = await drive({ mode: "none", failSave: true });
    expect(result.after).toBe(result.before);
    expect(result.events).toEqual([]);
    expect(result.policy).toMatchObject({ value: ["global-only"], source: "global" });
    expect(result.notices.some((call: any[]) => call[1] === "error" && call[0].includes("atomic save blocked"))).toBe(true);
  });
});

describe("policy provenance (not loaded extensions)", () => {
  it("shows the policy and provenance in the real agent detail menu", async () => {
    const env = hermeticDir({ settings: { schedulingEnabled: false, defaultExtensions: ["project-tools"] },
      agentFiles: { Explore: "---\nextensions: true\n---\nUntouched explicit Explore.\n" } });
    const h = makeUIPi();
    const ctx = makeContext({ cwd: env.dir, hasUI: true });
    ctx.ui.select = vi.fn().mockResolvedValueOnce(i18n.t("product.menuTypes", { count: 3 }))
      .mockResolvedValueOnce("Back");
    ctx.ui.custom = vi.fn().mockResolvedValueOnce("Explore").mockResolvedValue(undefined);
    const path = join(env.dir, ".pi/agents/Explore.md");
    const original = readFileSync(path, "utf8");
    try {
      productExtension(h.pi);
      await h.lifecycle.get("session_start")({}, ctx);
      await h.commands.get("config:subagents")!.handler("", ctx);
      const title = ctx.ui.select.mock.calls[1][0];
      expect(title).toContain(i18n.t("extensionDefaults.all"));
      expect(title).toContain(i18n.t("extensionDefaults.agentOverride", { path }));
      expect(title).not.toContain("project-tools");
      expect(title).not.toContain(join(env.dir, ".pi/subagents.json"));
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(getAgentConfig("Explore")?.extensions).toBe(true);
    } finally {
      await h.lifecycle.get("session_shutdown")?.({ reason: "quit" });
      registerAgents(new Map());
      delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
      env.restore();
    }
  });

  it("uses compatibility true, distinguishes explicit false/[] and respects trust layering", () => {
    const env = hermeticDir();
    try {
      expect(readDefaultExtensionPolicy(env.dir, true)).toEqual({ value: true, source: "fallback" });
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagents.json"), '{"defaultExtensions":false}');
      writeFileSync(join(env.dir, ".pi/subagents.json"), '{"defaultExtensions":[]}');
      expect(readDefaultExtensionPolicy(env.dir, true)).toMatchObject({ value: [], source: "project" });
      expect(readDefaultExtensionPolicy(env.dir, false)).toMatchObject({ value: false, source: "global" });
    } finally { env.restore(); }
  });

  it("describes omission, explicit overrides, exclusions and isolation without changing raw cfg", () => {
    const defaults = { value: ["default-tool"], source: "global" as const, path: "/test/global/subagents.json" };
    const cfg = { name: "test", description: "test", systemPrompt: "", sourcePath: "/test/agent.md", excludeExtensions: ["blocked"] } as any;
    const implicit = describeAgentExtensionPolicy(cfg, defaults);
    expect(implicit).toContain("default-tool");
    expect(implicit).toContain(defaults.path);
    expect(implicit).toContain("blocked");
    expect(implicit).toContain(i18n.t("extensionDefaults.detail", {
      policy: i18n.t("extensionDefaults.specifiedValue", { count: 1, names: "default-tool" }),
      source: i18n.t("extensionDefaults.source", { scope: i18n.t("extensionDefaults.global"), path: defaults.path }),
      exclusions: i18n.t("extensionDefaults.exclusions", { names: "blocked" }),
    }));
    for (const extensions of [true, false, [], ["explicit-tool"]]) {
      const explicit = describeAgentExtensionPolicy({ ...cfg, extensions }, defaults);
      expect(explicit).toContain(i18n.t("extensionDefaults.agentOverride", { path: cfg.sourcePath }));
      expect(explicit).not.toContain(defaults.path);
    }
    const isolated = describeAgentExtensionPolicy({ ...cfg, extensions: true, isolated: true }, defaults);
    expect(isolated).toContain(i18n.t("extensionDefaults.none"));
    expect(isolated).toContain(i18n.t("extensionDefaults.isolated"));
    expect(Object.hasOwn(cfg, "extensions")).toBe(false);
  });
});
