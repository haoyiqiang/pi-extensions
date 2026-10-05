import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_EXECUTION,
  getWorkflowConfigPaths,
  loadWorkflowConfig,
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
      execution: { backend: "terminal", maxConcurrency: 2, maxTurns: 10 },
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
      backend: "terminal",
      agentType: "general-purpose",
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
    json(paths.project, { execution: { backend: "embedded" } });

    const [skill] = loadWorkflowConfig(cwd, { agentDir }).skills;
    expect(skill?.filePath).toBe(resolve(dirname(paths.global), "skill/SKILL.md"));
    expect(skill?.baseDir).toBe(resolve(dirname(paths.global), "skill"));
  });

  it.each([
    ["malformed JSON", "{", /Invalid pi-workflow configuration/],
    ["unknown field", JSON.stringify({ execution: { surprise: true } }), /execution\.surprise: unknown field/],
    ["invalid backend", JSON.stringify({ execution: { backend: "remote" } }), /execution\.backend/],
    ["duplicate tools", JSON.stringify({ requiredTools: ["read", "read"] }), /duplicate value/],
  ])("fails closed for %s", (_label, content, expected) => {
    const { cwd, agentDir, paths } = workspace();
    mkdirSync(dirname(paths.project), { recursive: true });
    writeFileSync(paths.project, content);
    expect(() => loadWorkflowConfig(cwd, { agentDir })).toThrow(expected);
  });
});
