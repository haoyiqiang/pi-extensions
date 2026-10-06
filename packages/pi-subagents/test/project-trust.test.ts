import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasSubagentsProjectResources,
  resolveProjectTrusted,
} from "../src/project-trust.js";

describe("pi-subagents project trust", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagents-project-trust-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function customAgentOnly(): void {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "reviewer.md"), "---\ndescription: Reviewer\n---\nReview.");
  }

  it("detects custom project resources omitted by Pi 0.87 native trust discovery", () => {
    customAgentOnly();
    expect(hasSubagentsProjectResources(cwd)).toBe(true);
  });

  it("keeps a custom-only project global-only under the default ask policy", () => {
    customAgentOnly();
    expect(resolveProjectTrusted(cwd, {
      agentDir,
      context: { cwd, isProjectTrusted: () => true },
    })).toBe(false);
  });

  it("reuses Pi's saved trust decision without a second approval store", () => {
    customAgentOnly();
    new ProjectTrustStore(agentDir).set(cwd, true);
    expect(resolveProjectTrusted(cwd, {
      agentDir,
      context: { cwd, isProjectTrusted: () => true },
    })).toBe(true);
  });

  it("lets an explicit config-root decision override custom-only ambiguity", () => {
    customAgentOnly();
    expect(resolveProjectTrusted(cwd, {
      agentDir,
      projectTrusted: true,
      context: { cwd, isProjectTrusted: () => false },
    })).toBe(true);
    expect(resolveProjectTrusted(cwd, {
      agentDir,
      projectTrusted: false,
      context: { cwd, isProjectTrusted: () => true },
    })).toBe(false);
  });

  it("uses the active context decision for native protected resources", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{}");
    expect(resolveProjectTrusted(cwd, {
      agentDir,
      context: { cwd, isProjectTrusted: () => false },
    })).toBe(false);
  });
});
