import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_EXECUTION,
  getWorkflowConfigPaths,
  loadWorkflowConfig,
  resolveWorkflowModel,
} from "./config.js";

const roots: string[] = [];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-config-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, agentDir, paths: getWorkflowConfigPaths(cwd, agentDir) };
}

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi workflow configuration", () => {
  it("uses portable defaults when both layers are missing", () => {
    const { cwd, agentDir } = workspace();
    expect(loadWorkflowConfig(cwd, { agentDir })).toEqual({
      execution: DEFAULT_WORKFLOW_EXECUTION,
      skills: [],
      requiredTools: [],
    });
  });

  it("merges project execution fields while project arrays replace global arrays", () => {
    const { cwd, agentDir, paths } = workspace();
    json(paths.global, {
      execution: { profile: "managed", backend: "terminal", maxConcurrency: 2, maxTurns: 10 },
      requiredTools: ["read", "bash"],
      skills: [{
        name: "global",
        filePath: "./skills/global/SKILL.md",
        baseDir: "./skills/global",
        format: "pi",
      }],
    });
    json(paths.project, {
      execution: { maxConcurrency: 7 },
      requiredTools: ["read"],
      skills: [{
        name: "project",
        filePath: "./skills/project/SKILL.md",
        baseDir: "./skills/project",
        format: "positional-v1",
      }],
    });

    const config = loadWorkflowConfig(cwd, { agentDir });
    expect(config.execution).toEqual({
      executor: "pi-subagents",
      profile: "managed",
      backend: "terminal",
      maxConcurrency: 7,
      maxTurns: 10,
    });
    expect(config.requiredTools).toEqual(["read"]);
    expect(config.skills).toEqual([{
      name: "project",
      filePath: resolve(dirname(paths.project), "skills/project/SKILL.md"),
      baseDir: resolve(dirname(paths.project), "skills/project"),
      format: "positional-v1",
    }]);
  });

  it("overlays model tier keys and resolves preset → stage → skill → defaults without cross-tier field merging", () => {
    const { cwd, agentDir, paths } = workspace();
    json(paths.global, {
      models: {
        defaults: { model: "global/default", thinking: "medium" },
        stages: {
          review: { model: "global/stage", thinking: "high" },
          retained: "global/retained",
        },
        skills: { audit: { model: "global/skill" } },
        presets: { inspect: { stages: { review: { model: "global/preset" } } } },
      },
    });
    json(paths.project, {
      models: {
        stages: { review: { thinking: "off" } },
        presets: { inspect: { stages: { review: "project/preset" } } },
      },
    });

    const config = loadWorkflowConfig(cwd, { agentDir });
    expect(resolveWorkflowModel(config, { workflow: "inspect", stage: "review", skill: "audit" }))
      .toEqual({ model: "project/preset", thinking: "medium" });
    expect(resolveWorkflowModel(config, { workflow: "other", stage: "review", skill: "audit" }))
      .toEqual({ model: "global/default", thinking: "off" });
    expect(resolveWorkflowModel(config, { workflow: "other", stage: "missing", skill: "audit" }))
      .toEqual({ model: "global/skill", thinking: "medium" });
    expect(resolveWorkflowModel(config, { workflow: "toString", stage: "constructor", skill: "audit" }))
      .toEqual({ model: "global/skill", thinking: "medium" });
    expect(resolveWorkflowModel(config, { workflow: "other", stage: "retained", skill: "missing" }))
      .toEqual({ model: "global/retained", thinking: "medium" });
    expect(resolveWorkflowModel(config, { workflow: "other", stage: "missing", skill: "missing" }))
      .toEqual({ model: "global/default", thinking: "medium" });
  });

  it("lets project model defaults replace the global defaults leaf", () => {
    const { cwd, agentDir, paths } = workspace();
    json(paths.global, { models: { defaults: { model: "global/default", thinking: "high" } } });
    json(paths.project, { models: { defaults: { thinking: "off" } } });

    const config = loadWorkflowConfig(cwd, { agentDir });
    expect(resolveWorkflowModel(config, { workflow: "flow", stage: "work", skill: "work" }))
      .toEqual({ thinking: "off" });
  });

  it("resolves inherited skill paths relative to the layer that defined them", () => {
    const { cwd, agentDir, paths } = workspace();
    json(paths.global, {
      skills: [{
        name: "global",
        filePath: "./skill/SKILL.md",
        baseDir: "./skill",
        format: "pi",
      }],
    });
    json(paths.project, { execution: { profile: "managed", backend: "embedded" } });

    const [skill] = loadWorkflowConfig(cwd, { agentDir }).skills;
    expect(skill?.filePath).toBe(resolve(dirname(paths.global), "skill/SKILL.md"));
    expect(skill?.baseDir).toBe(resolve(dirname(paths.global), "skill"));
  });

  it.each([
    ["malformed JSON", "{", /Invalid pi-workflow configuration/],
    ["unknown field", JSON.stringify({ execution: { surprise: true } }), /execution\.surprise: unknown field/],
    ["invalid backend", JSON.stringify({ execution: { backend: "remote" } }), /execution\.backend/],
    ["invalid thinking", JSON.stringify({ models: { defaults: { thinking: "extreme" } } }), /thinking/],
    ["duplicate tools", JSON.stringify({ requiredTools: ["read", "read"] }), /duplicate value/],
  ])("fails closed for %s", (_label, content, expected) => {
    const { cwd, agentDir, paths } = workspace();
    mkdirSync(dirname(paths.project), { recursive: true });
    writeFileSync(paths.project, content);
    expect(() => loadWorkflowConfig(cwd, { agentDir })).toThrow(expected);
  });
});
