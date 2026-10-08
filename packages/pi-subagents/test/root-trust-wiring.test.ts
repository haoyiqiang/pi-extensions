import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { i18n } from "../src/i18n.js";
import { ctx, makePi } from "./helpers/boot-extension.js";

const dirs: string[] = [];
let previousCwd: string;
let previousAgentDir: string | undefined;
let previousHome: string | undefined;

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(path);
  return path;
}

function projectFixture() {
  const project = temp("pi-root-trust-project-");
  mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  writeFileSync(join(project, ".pi", "subagents.json"), JSON.stringify({
    schedulingEnabled: false,
    toolDescriptionMode: "custom",
  }));
  writeFileSync(
    join(project, ".pi", "agent-tool-description.md"),
    "PROJECT TOOL DESCRIPTION\n{{typeList}}",
  );
  writeFileSync(
    join(project, ".pi", "agents", "project-only.md"),
    "---\ndescription: project-only definition\ntools: none\nextensions: false\n---\nProject prompt.\n",
  );
  new ProjectTrustStore(getAgentDir()).set(project, true);
  return project;
}

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  previousCwd = process.cwd();
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousHome = process.env.HOME;
  const bootstrap = temp("pi-root-trust-bootstrap-");
  const agentDir = temp("pi-root-trust-agentdir-");
  process.chdir(bootstrap);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = agentDir;
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  vi.restoreAllMocks();
});

describe("root project-trust binding", () => {
  it("boots global-only, then rebuilds the Agent schema and description from the trusted session cwd", async () => {
    const project = projectFixture();
    const booted = makePi();
    subagentsExtension(booted.pi);

    const before = booted.tools.get("Agent");
    expect(before.description).not.toContain("PROJECT TOOL DESCRIPTION");
    expect(before.description).not.toContain("project-only");
    expect(before.parameters.properties).toHaveProperty("schedule");

    const sessionCtx = ctx({ cwd: project, isProjectTrusted: () => true, mode: "json" });
    await booted.lifecycle.get("session_start")?.({}, sessionCtx);

    const after = booted.tools.get("Agent");
    expect(after.description).toContain("PROJECT TOOL DESCRIPTION");
    expect(after.description).toContain("- project-only: project-only definition (Tools: none)");
    expect(after.parameters.properties).not.toHaveProperty("schedule");
    await booted.lifecycle.get("session_shutdown")?.();
  });

  it("never reads project definitions or project tool prose for an untrusted session", async () => {
    const project = projectFixture();
    const booted = makePi();
    subagentsExtension(booted.pi);

    const sessionCtx = ctx({ cwd: project, isProjectTrusted: () => false, mode: "json" });
    await booted.lifecycle.get("session_start")?.({}, sessionCtx);

    const tool = booted.tools.get("Agent");
    expect(tool.description).not.toContain("PROJECT TOOL DESCRIPTION");
    expect(tool.description).not.toContain("project-only");
    expect(tool.parameters.properties).toHaveProperty("schedule");
    await booted.lifecycle.get("session_shutdown")?.();
  });

  it("does not mistake native implicit true for approval of custom-only project resources", async () => {
    const project = projectFixture();
    new ProjectTrustStore(getAgentDir()).set(project, null);
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")?.({}, ctx({ cwd: project, isProjectTrusted: () => true, mode: "json" }));
    expect(booted.tools.get("Agent").description).not.toContain("project-only");
    await booted.lifecycle.get("session_shutdown")?.();
  });

  it("captures fresh-spawn policy and ignores forged RPC/backend ownership fields", async () => {
    const project = projectFixture();
    const booted = makePi();
    const session = {
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
    } as any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });
    subagentsExtension(booted.pi);
    const sessionCtx = ctx({ cwd: project, isProjectTrusted: () => true, mode: "json" });
    await booted.lifecycle.get("session_start")?.({}, sessionCtx);

    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registry.spawn(booted.pi, sessionCtx, "project-only", "inspect policy", {
      description: "policy probe",
      backend: "terminal",
      configCwd: "/forged",
      agentConfig: { name: "evil", description: "forged" },
      runtimePolicy: { configCwd: "/forged", projectTrusted: false },
    });

    await vi.waitFor(() => expect(runAgent).toHaveBeenCalled());
    const options = vi.mocked(runAgent).mock.calls.at(-1)![3] as any;
    expect(options.configCwd).toBe(project);
    expect(options.runtimePolicy).toMatchObject({ configCwd: project, projectTrusted: true });
    expect(options.agentConfig).toMatchObject({ name: "project-only", description: "project-only definition" });
    await booted.lifecycle.get("session_shutdown")?.();
  });

  it("refuses the project settings UI without rewriting either project or global config", async () => {
    const project = projectFixture();
    const projectSettings = join(project, ".pi", "subagents.json");
    const original = readFileSync(projectSettings, "utf8");
    const booted = makePi();
    subagentsExtension(booted.pi);

    const notices: string[] = [];
    const choices = ["Settings", undefined];
    const sessionCtx = ctx({
      cwd: project,
      isProjectTrusted: () => false,
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn((message: string) => notices.push(message)),
        addAutocompleteProvider: vi.fn(),
        onTerminalInput: vi.fn(() => vi.fn()),
        getEditorText: vi.fn(() => ""),
        select: vi.fn(async () => choices.shift()),
      },
    });
    await booted.lifecycle.get("session_start")?.({}, sessionCtx);
    await booted.commands.get("config:subagents").handler("", sessionCtx);

    expect(readFileSync(projectSettings, "utf8")).toBe(original);
    expect(notices.some(message => message.includes(i18n.t("product.projectUntrusted")))).toBe(true);
    expect(booted.tools.get("Agent").description).not.toContain("PROJECT TOOL DESCRIPTION");
    await booted.lifecycle.get("session_shutdown")?.();
  });
});
