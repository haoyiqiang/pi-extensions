import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  shellEscape, isFishShell, exitStatusVar, isHeadlessSurface, createHeadlessSurface,
  isHeadlessMode, getMuxBackend, muxSetupHint, getAgentPaneId, getRenameCapability,
  renameCurrentTab, renameWorkspace,
} from "../src/index.ts";

const ENV_KEYS = ["TMUX", "TMUX_PANE", "TERM_PROGRAM", "PI_TERMINAL_MUX", "PI_SUBAGENT_MUX", "SHELL"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("shell helpers", () => {
  test("quotes strings, embedded quotes, and empty values", () => {
    assert.equal(shellEscape("abc"), "'abc'");
    assert.equal(shellEscape("a'b"), "'a'\\''b'");
    assert.equal(shellEscape(""), "''");
  });
  test("fish and Bash use their own exit status variables", () => {
    process.env.SHELL = "/bin/fish";
    assert.equal(isFishShell(), true);
    assert.equal(exitStatusVar(), "$status");
    process.env.SHELL = "/bin/bash";
    assert.equal(isFishShell(), false);
    assert.equal(exitStatusVar(), "$?");
  });
});

describe("backend detection", () => {
  test("a clean environment uses headless mode", () => {
    assert.equal(getMuxBackend(), null);
    assert.equal(isHeadlessMode(), true);
    assert.equal(isHeadlessSurface(createHeadlessSurface("worker")), true);
  });
  test("an unavailable forced backend never selects another backend", () => {
    process.env.PI_TERMINAL_MUX = "tmux";
    assert.equal(getMuxBackend(), null);
    process.env.PI_TERMINAL_MUX = "orca";
    assert.equal(getMuxBackend(), null);
  });
  test("the legacy preference alias remains supported", () => {
    process.env.PI_SUBAGENT_MUX = "tmux";
    assert.equal(getMuxBackend(), null);
    process.env.PI_TERMINAL_MUX = "orca";
    assert.equal(getMuxBackend(), null);
  });
  test("removed and unknown backend preferences fail explicitly", () => {
    for (const backend of ["cmux", "muxy", "herdr", "otty", "wezterm", "zellij", "unknown"]) {
      process.env.PI_TERMINAL_MUX = backend;
      assert.throws(() => getMuxBackend(), /Unsupported terminal multiplexer/);
    }
  });
  test("setup hints mention only supported terminals", () => {
    assert.match(muxSetupHint(), /tmux or Orca/);
    process.env.PI_TERMINAL_MUX = "tmux";
    assert.match(muxSetupHint(), /Start pi inside tmux/);
    process.env.PI_TERMINAL_MUX = "orca";
    assert.match(muxSetupHint(), /Run pi inside Orca/);
  });
  test("explicit null means no agent pane", () => {
    process.env.TMUX_PANE = "%42";
    assert.equal(getAgentPaneId("tmux"), "%42");
    assert.equal(getAgentPaneId(null), null);
    assert.equal(getAgentPaneId(), null);
  });
});

describe("rename capabilities", () => {
  test("headless renaming explicitly reports unsupported", () => {
    assert.deepEqual(renameCurrentTab("title"), { status: "unsupported", backend: "headless", operation: "tab" });
    assert.deepEqual(renameWorkspace("title"), { status: "unsupported", backend: "headless", operation: "workspace" });
  });
  test("tmux legacy renaming requires explicit opt-ins", () => {
    assert.deepEqual(getRenameCapability("tab", "tmux", {}), {
      status: "disabled", backend: "tmux", operation: "tab", setting: "PI_SUBAGENT_RENAME_TMUX_WINDOW",
    });
    assert.deepEqual(getRenameCapability("workspace", "tmux", {}), {
      status: "disabled", backend: "tmux", operation: "workspace", setting: "PI_SUBAGENT_RENAME_TMUX_SESSION",
    });
    assert.deepEqual(getRenameCapability("tab", "tmux", { PI_SUBAGENT_RENAME_TMUX_WINDOW: "1" }), {
      status: "supported", backend: "tmux", operation: "tab", target: "window",
    });
    assert.deepEqual(getRenameCapability("workspace", "tmux", { PI_SUBAGENT_RENAME_TMUX_SESSION: "1" }), {
      status: "supported", backend: "tmux", operation: "workspace", target: "session",
    });
  });
  test("Orca can rename terminals, not workspaces", () => {
    assert.deepEqual(getRenameCapability("tab", "orca", {}), {
      status: "supported", backend: "orca", operation: "tab", target: "terminal",
    });
    assert.deepEqual(getRenameCapability("workspace", "orca", {}), {
      status: "unsupported", backend: "orca", operation: "workspace",
    });
  });
});
