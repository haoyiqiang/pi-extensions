import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isOrdinaryChildProduct,
  resolveChildAgentConfig,
  withoutOrdinaryChildProducts,
} from "../src/child-resource-policy.js";
import type { AgentConfig } from "../src/types.js";
import { registerAgents } from "../src/agent-types.js";

function extension(path: string): Extension {
  return { path, resolvedPath: path } as unknown as Extension;
}

function result(...extensions: Extension[]): LoadExtensionsResult {
  return { extensions, errors: [], runtime: {} } as unknown as LoadExtensionsResult;
}

describe("ordinary child extension policy", () => {
  const ordinary = extension("/repo/packages/pi-web-search/index.ts");
  const workflow = extension("/repo/packages/pi-workflow/extension.ts");
  const spark = extension("/repo/packages/pi-spark/index.ts");

  it("removes root orchestration and UI products but keeps ordinary extensions", () => {
    expect(isOrdinaryChildProduct(workflow)).toBe(true);
    expect(isOrdinaryChildProduct(spark)).toBe(true);
    expect(isOrdinaryChildProduct(ordinary)).toBe(false);
    expect(withoutOrdinaryChildProducts(result(ordinary, workflow, spark)).extensions).toEqual([ordinary]);
  });

  it("removes extensions whose package declares ambientObserver", () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-ambient-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "ambient-fixture",
        pi: { ambientObserver: true, extensions: ["./src/index.ts"] },
      }));
      const ambient = extension(join(root, "src", "index.ts"));
      expect(isOrdinaryChildProduct(ambient)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("child agent trust policy", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagents-child-policy-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("replaces a captured project definition with the global definition when untrusted", () => {
    writeFileSync(join(agentDir, "agents", "reviewer.md"), `---
description: Global reviewer
extensions: false
skills: false
---
Global prompt.`);
    const captured: AgentConfig = {
      name: "reviewer",
      description: "Project reviewer",
      extensions: ["./untrusted-extension.ts"],
      skills: true,
      systemPrompt: "Project prompt.",
      promptMode: "replace",
      source: "project",
      sourcePath: join(cwd, ".pi", "agents", "reviewer.md"),
    };

    const resolved = resolveChildAgentConfig("reviewer", captured, {
      configCwd: cwd,
      projectTrusted: false,
    });
    expect(resolved).toMatchObject({
      description: "Global reviewer",
      extensions: false,
      skills: false,
      source: "global",
    });
  });

  it("keeps an explicit programmatic definition in global-only mode", () => {
    const explicit: AgentConfig = {
      name: "sdk-agent",
      description: "SDK approved",
      extensions: ["/approved/global-extension.ts"],
      skills: false,
      systemPrompt: "Approved.",
      promptMode: "replace",
    };
    expect(resolveChildAgentConfig("sdk-agent", explicit, {
      configCwd: cwd,
      projectTrusted: false,
    })).toBe(explicit);
    registerAgents(new Map([["sdk-agent", explicit]]));
    try {
      expect(resolveChildAgentConfig("sdk-agent", undefined, {
        configCwd: cwd, projectTrusted: false,
      })).toBe(explicit);
    } finally { registerAgents(new Map()); }
  });
});
