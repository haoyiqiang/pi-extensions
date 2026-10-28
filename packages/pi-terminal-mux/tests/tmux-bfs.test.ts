import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

let api: typeof import("../src/index.ts");
let directory = "";

/** 模拟 agent 自己的 pane；BFS marker 以它命名 */
const BASE = "%bfs";
const markerPath = (): string => join(tmpdir(), "tmux-subagent-pane-_bfs.json");

const keys = ["PATH", "TMUX", "TMUX_PANE", "TERM_PROGRAM", "ORCA_TERMINAL_HANDLE", "PI_TERMINAL_MUX", "PI_SUBAGENT_MUX", "FAKE_TMUX_DIR"];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

interface Placement {
  dir: "right" | "down";
  from: string | undefined;
}

/** 记录每次 split 的方向和来源 pane */
function placements(): Placement[] {
  const text = readFileSync(join(directory, "log.jsonl"), "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "split-window")
    .map((args) => ({ dir: args.includes("-h") ? "right" : "down", from: args[args.indexOf("-t") + 1] }));
}

function fakeState(state: { next: number; panes: string[] }): void {
  writeFileSync(join(directory, "state.json"), JSON.stringify(state));
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "pi-mux-tmux-bfs-"));
  const fake = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const directory = process.env.FAKE_TMUX_DIR;
const statePath = join(directory, "state.json");
const args = process.argv.slice(2);
appendFileSync(join(directory, "log.jsonl"), JSON.stringify(args) + "\\n");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { next: 10, panes: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
if (args[0] === "split-window") {
  const pane = "%" + state.next++;
  state.panes.push(pane);
  save();
  process.stdout.write(pane + "\\n");
} else if (args[0] === "list-panes") {
  process.stdout.write(state.panes.join("\\n") + "\\n");
} else if (args[0] === "kill-pane") {
  const target = args[args.indexOf("-t") + 1];
  state.panes = state.panes.filter((pane) => pane !== target);
  save();
}
`;
  writeFileSync(join(directory, "tmux"), fake, { mode: 0o755 });
  process.env.PATH = `${directory}${delimiter}${original.PATH ?? ""}`;
  process.env.FAKE_TMUX_DIR = directory;
  process.env.TMUX = "/tmp/fake-tmux-socket,1,0";
  process.env.TMUX_PANE = BASE;
  process.env.PI_TERMINAL_MUX = "tmux";
  delete process.env.TERM_PROGRAM;
  delete process.env.PI_SUBAGENT_MUX;
  api = await import("../src/index.ts");
});

beforeEach(() => {
  writeFileSync(join(directory, "log.jsonl"), "");
  fakeState({ next: 10, panes: [] });
  rmSync(markerPath(), { force: true });
});

after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(markerPath(), { force: true });
  rmSync(directory, { recursive: true, force: true });
});

test("tmux layouts subagents as a BFS grid instead of one narrow row", () => {
  for (const name of ["a", "b", "c", "d"]) api.createSurface(name);

  // 第一次向右；之后从已有 pane 交替向下 / 向右，形成二维网格
  assert.deepEqual(placements(), [
    { dir: "right", from: BASE },
    { dir: "down", from: "%10" },
    { dir: "right", from: "%10" },
    { dir: "right", from: "%11" },
  ]);
});

test("a closed tmux pane is dropped from the grid state", () => {
  api.createSurface("a");
  api.closeSurface("%10");
  api.createSurface("b");

  assert.deepEqual(placements(), [
    { dir: "right", from: BASE },
    { dir: "right", from: BASE },
  ]);
});

test("a pane closed outside pi resets placement instead of splitting a dead one", () => {
  api.createSurface("a");
  fakeState({ next: 20, panes: [] });
  api.createSurface("b");

  assert.deepEqual(placements(), [
    { dir: "right", from: BASE },
    { dir: "right", from: BASE },
  ]);
});
