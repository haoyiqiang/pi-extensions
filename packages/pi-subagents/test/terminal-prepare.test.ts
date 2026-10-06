import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_RENAME_CONTEXT_ENV } from "pi-terminal-mux";
import {
  registerAgents,
  setDefaultsDisabled,
} from "../src/agent-types.js";
import { setDefaultMaxTurns, setGraceTurns } from "../src/backends/embedded.js";
import type { PersistentSessionReference } from "../src/backends/session-reference.js";
import type { ExecutionRunOptions } from "../src/backends/types.js";
import { TERMINAL_MANIFEST_ENV, type TerminalChildManifest } from "../src/backends/terminal/bridge-protocol.js";
import {
  createTerminalSession,
  prepareTerminalLaunch,
  prepareTerminalPolicy,
  type TerminalBackendConfig,
  type TerminalPolicy,
} from "../src/backends/terminal/prepare.js";
import type { AgentConfig } from "../src/types.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

const tempDirectories: string[] = [];

function temp(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirectories.push(directory);
  return directory;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "terminal-test",
    displayName: "Terminal Test",
    description: "test agent",
    builtinToolNames: ["read", "write"],
    extensions: false,
    skills: false,
    systemPrompt: "Agent instructions.",
    promptMode: "append",
    ...overrides,
  };
}

function install(config: AgentConfig): void {
  registerAgents(new Map([[config.name, config]]));
}

function model(provider = "provider", id = "model") {
  return { provider, id, name: "Model", headers: { authorization: "secret" }, apiKey: "secret" } as any;
}

function context(cwd: string, parentModel: any = model()) {
  return {
    cwd,
    model: parentModel,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => provider === "provider" && id === "configured" ? model(provider, id) : undefined),
      getAvailable: vi.fn(() => [model("provider", "configured")]),
    },
    getSystemPrompt: vi.fn(() => "Parent system prompt."),
  } as any;
}

function options(piExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }))): ExecutionRunOptions {
  return {
    pi: { exec: piExec } as any,
    isolated: true,
  };
}

function policy(cwd: string, overrides: Partial<TerminalPolicy> = {}): TerminalPolicy {
  return {
    type: "terminal-test",
    name: "Terminal Test",
    cwd,
    model: { provider: "provider", id: "model" },
    tools: ["read"],
    systemPrompt: "Resolved system prompt.",
    ...overrides,
  };
}

function config(root: string, overrides: Partial<TerminalBackendConfig> = {}): TerminalBackendConfig {
  return {
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    artifactDir: join(root, "runs"),
    executable: "/explicit/pi-runtime",
    executableArgs: ["cli-entry.js", "--runtime-flag"],
    ...overrides,
  };
}

function endpoint(): TerminalChildManifest["endpoint"] {
  return { host: "127.0.0.1", port: 32123, token: "capability-token" };
}

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  setDefaultsDisabled(false);
  registerAgents(new Map());
  setDefaultMaxTurns(undefined);
  setGraceTurns(5);
});

afterEach(() => {
  setDefaultsDisabled(false);
  registerAgents(new Map());
  setDefaultMaxTurns(undefined);
  setGraceTurns(5);
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("terminal policy preparation", () => {
  it("resolves isolated model, thinking, tools and the existing prompt builder inputs", async () => {
    const cwd = temp("terminal-policy");
    install(agent({
      model: "provider/configured",
      thinking: "low",
      disallowedTools: ["write"],
    }));
    const piExec = vi.fn(async (command: string, args: string[]) => {
      if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "" };
      return { code: 0, stdout: "feature/terminal\n", stderr: "" };
    });

    const prepared = await prepareTerminalPolicy(context(cwd), "terminal-test", {
      ...options(piExec),
      thinkingLevel: "high",
      worktreeBase: "/main/repository",
      workflow: true,
      nestedRuntime: { manager: {}, parentAgentId: "parent", depth: 1 } as any,
    });

    expect(prepared).toMatchObject({
      type: "terminal-test",
      name: "Terminal Test",
      cwd,
      model: { provider: "provider", id: "configured" },
      thinkingLevel: "high",
      tools: ["read"],
    });
    expect(prepared.systemPrompt).toContain("Parent system prompt.");
    expect(prepared.systemPrompt).toContain("Branch: feature/terminal");
    expect(prepared.systemPrompt).toContain("<worktree_isolation>");
    expect(prepared.systemPrompt).toContain("<workflow_child>");
    expect(prepared.model).not.toHaveProperty("headers");
    expect(prepared.model).not.toHaveProperty("apiKey");
    expect(piExec).toHaveBeenCalledTimes(2);
  });

  it("lets an explicit model outrank the agent model and supports an empty tool set", async () => {
    const cwd = temp("terminal-empty-tools");
    install(agent({ builtinToolNames: [], model: "provider/configured" }));
    const explicit = model("explicit", "chosen");
    const prepared = await prepareTerminalPolicy(context(cwd), "terminal-test", {
      ...options(),
      model: explicit,
    });
    expect(prepared.model).toEqual({ provider: "explicit", id: "chosen" });
    expect(prepared.tools).toEqual([]);
  });

  it("uses built-in default agent definitions without inventing an unknown-type fallback", async () => {
    const cwd = temp("terminal-default-agent");
    const prepared = await prepareTerminalPolicy(context(cwd), "general-purpose", options());
    expect(prepared.type).toBe("general-purpose");
    expect(prepared.tools.length).toBeGreaterThan(0);

    await expect(prepareTerminalPolicy(context(cwd), "not-an-agent", options()))
      .rejects.toThrow();
  });

  it("does not resurrect disabled built-in defaults through the preparation fallback", async () => {
    const cwd = temp("terminal-disabled-defaults");
    setDefaultsDisabled(true);
    registerAgents(new Map());
    const piExec = vi.fn();
    await expect(prepareTerminalPolicy(context(cwd), "general-purpose", options(piExec))).rejects.toThrow();
    expect(piExec).not.toHaveBeenCalled();
  });

  it.each([
    ["non-isolated execution", (base: ExecutionRunOptions) => ({ ...base, isolated: false })],
    ["inherited conversation context", (base: ExecutionRunOptions) => ({ ...base, inheritContext: true })],
    ["session resume", (base: ExecutionRunOptions) => ({ ...base, resumeSessionFile: "/tmp/old.jsonl" })],
    ["structured output", (base: ExecutionRunOptions) => ({ ...base, structuredOutput: {} as any })],
    ["invalid turn limit", (base: ExecutionRunOptions) => ({ ...base, maxTurns: NaN })],
  ])("rejects %s before environment process work", async (_name, mutate) => {
    const cwd = temp("terminal-reject-option");
    install(agent());
    const piExec = vi.fn();
    await expect(prepareTerminalPolicy(context(cwd), "terminal-test", mutate(options(piExec))))
      .rejects.toThrow();
    expect(piExec).not.toHaveBeenCalled();
  });

  it.each([
    ["memory", { memory: "project" as const }],
    ["disabled persistence", { persistSession: false }],
  ])("rejects agent %s before environment process work", async (_name, overrides) => {
    const cwd = temp("terminal-reject-agent");
    install(agent(overrides));
    const piExec = vi.fn();
    await expect(prepareTerminalPolicy(context(cwd), "terminal-test", options(piExec)))
      .rejects.toThrow();
    expect(piExec).not.toHaveBeenCalled();
  });

  it("resolves explicit, agent and global budgets with the existing unlimited override", async () => {
    const cwd = temp("terminal-resolve-budget");
    install(agent());
    setDefaultMaxTurns(9);
    setGraceTurns(2);
    expect(await prepareTerminalPolicy(context(cwd), "terminal-test", options())).toMatchObject({ maxTurns: 9, graceTurns: 2 });
    install(agent({ maxTurns: 4 }));
    expect(await prepareTerminalPolicy(context(cwd), "terminal-test", options())).toMatchObject({ maxTurns: 4, graceTurns: 2 });
    expect(await prepareTerminalPolicy(context(cwd), "terminal-test", { ...options(), maxTurns: 1 })).toMatchObject({ maxTurns: 1, graceTurns: 2 });
    const unlimited = await prepareTerminalPolicy(context(cwd), "terminal-test", { ...options(), maxTurns: 0 });
    expect(unlimited.maxTurns).toBeUndefined();
    expect(unlimited.graceTurns).toBeUndefined();
  });

  it("snapshots JSON-only schemas and carries policy through the private manifest", async () => {
    const cwd = temp("terminal-schema");
    install(agent());
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    const result = compileJsonSchema(schema);
    if (result.ok === false) throw new Error(result.message);
    const selected = await prepareTerminalPolicy(context(cwd), "terminal-test", { ...options(), structuredOutput: result.compiled, workflow: true, maxTurns: 3 });
    expect(selected.systemPrompt).not.toContain("<workflow_child>");
    schema.properties.answer.type = "number";
    expect((selected.structuredSchema!.properties as any).answer.type).toBe("string");
    expect(Object.isFrozen(selected.structuredSchema!.properties)).toBe(true);
    const session = createTerminalSession(selected, config(cwd));
    const launch = prepareTerminalLaunch(selected, session, "run", endpoint(), "task", config(cwd));
    const manifest = json(join(dirname(launch.launchScriptFile), "manifest.json"));
    expect(manifest).toMatchObject({ maxTurns: 3, graceTurns: 5, structuredSchema: selected.structuredSchema });
    expect(manifest.tools).not.toContain("StructuredOutput");
    expect(JSON.stringify(manifest)).not.toContain("check");
  });

  it.each([Infinity, NaN, Number.MAX_SAFE_INTEGER])("rejects invalid budgets before environment work: %s", async (maxTurns) => {
    const cwd = temp("terminal-invalid-budget");
    install(agent());
    const exec = vi.fn();
    await expect(prepareTerminalPolicy(context(cwd), "terminal-test", { ...options(exec), maxTurns })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails unknown isolated tools and a missing model before environment process work", async () => {
    const cwd = temp("terminal-reject-resolution");
    const piExec = vi.fn();
    install(agent({ builtinToolNames: ["read", "not-a-real-tool"] }));
    await expect(prepareTerminalPolicy(context(cwd), "terminal-test", options(piExec)))
      .rejects.toThrow();
    expect(piExec).not.toHaveBeenCalled();

    install(agent({ builtinToolNames: ["read"] }));
    await expect(prepareTerminalPolicy(context(cwd, null), "terminal-test", options(piExec)))
      .rejects.toThrow();
    expect(piExec).not.toHaveBeenCalled();
  });
});

describe("terminal session and launch preparation", () => {
  it.each([{ tools: [] }, { tools: ["read"] }])("admits the synthetic tool in Pi's persistent CLI allowlist, with builtins %j", ({ tools }) => {
    const root = temp("terminal-structured-cli");
    const selected = policy(root, { tools, structuredSchema: { type: "object" } });
    const session = createTerminalSession(selected, config(root));
    const launch = prepareTerminalLaunch(selected, session, "schema-run", endpoint(), "task", config(root));
    const launchConfig = json(join(dirname(launch.launchScriptFile), "launch.json"));
    expect(launchConfig.args).not.toContain("--no-tools");
    expect(launchConfig.args[launchConfig.args.indexOf("--tools") + 1]).toBe([...tools, "StructuredOutput"].join(","));
    expect(json(join(dirname(launch.launchScriptFile), "manifest.json")).tools).toEqual(tools);
  });

  it("seeds a fresh private v3 transcript and returns a stable persistent reference", () => {
    const root = temp("terminal-session");
    const selectedPolicy = policy(root);
    const reference = createTerminalSession(selectedPolicy, config(root));

    expect(reference).toEqual({
      backend: "terminal",
      sessionId: expect.any(String),
      sessionFile: join(root, "sessions", `${reference.sessionId}.jsonl`),
    });
    const lines = readFileSync(reference.sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "session",
      version: 3,
      id: reference.sessionId,
      timestamp: expect.any(String),
      cwd: root,
    });
    if (process.platform !== "win32") expect(mode(reference.sessionFile)).toBe(0o600);
    expect(Object.isFrozen(reference)).toBe(true);
  });

  it("materializes private unique run artifacts and exact isolated CLI arguments", () => {
    const root = temp("terminal-launch");
    const providerExtension = join(root, "trusted provider's extension.ts");
    const selectedPolicy = policy(root, {
      thinkingLevel: "high",
      tools: ["read", "grep"],
      model: { provider: "provider", id: "model", headers: { authorization: "never-write" } } as any,
    });
    const selectedConfig = config(root, {
      providerExtensions: [providerExtension],
      mode: "json",
    });
    const reference = createTerminalSession(selectedPolicy, selectedConfig);

    const first = prepareTerminalLaunch(selectedPolicy, reference, "run-one", endpoint(), "Task one", selectedConfig);
    const second = prepareTerminalLaunch(selectedPolicy, reference, "run-two", endpoint(), "Task two", selectedConfig);
    const firstDirectory = dirname(first.launchScriptFile);
    const secondDirectory = dirname(second.launchScriptFile);

    expect(firstDirectory).not.toBe(secondDirectory);
    expect(first.interpreter).toBe("bash");
    expect(first.run).toEqual({ runId: "run-one", session: reference });
    expect(first).not.toHaveProperty("signal");
    expect(readFileSync(join(firstDirectory, "prompt.txt"), "utf8")).toBe("Task one");
    expect(readFileSync(join(firstDirectory, "system-prompt.txt"), "utf8")).toBe(selectedPolicy.systemPrompt);

    const manifest = json(join(firstDirectory, "manifest.json"));
    expect(manifest).toEqual({
      version: 1,
      run: { runId: "run-one", session: reference },
      endpoint: endpoint(),
      model: { provider: "provider", id: "model" },
      tools: ["read", "grep"],
      systemPrompt: selectedPolicy.systemPrompt,
    });
    expect(JSON.stringify(manifest)).not.toContain("never-write");

    const launch = json(join(firstDirectory, "launch.json"));
    expect(launch.executable).toBe("/explicit/pi-runtime");
    expect(launch.cwd).toBe(root);
    expect(launch.env).toEqual({
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_SUBAGENT_NAME: "Terminal Test",
      PI_SUBAGENT_SESSION: reference.sessionFile,
      PI_SUBAGENT_ID: "run-one",
      PI_SUBAGENT_AUTO_EXIT: "1",
      PI_SUBAGENT_INTERACTIVE: "",
      [TERMINAL_MANIFEST_ENV]: join(firstDirectory, "manifest.json"),
    });
    expect(launch.args.slice(0, 2)).toEqual(["cli-entry.js", "--runtime-flag"]);
    expect(launch.args).toEqual(expect.arrayContaining([
      "-e",
      providerExtension,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--no-approve",
      "--model",
      "provider/model",
      "--thinking",
      "high",
      "--session",
      reference.sessionFile,
      "--system-prompt",
      join(firstDirectory, "system-prompt.txt"),
      "--tools",
      "read,grep",
      "--mode",
      "json",
    ]));
    expect(launch.args.filter((argument: string) => argument === "--session")).toHaveLength(1);
    expect(launch.args).not.toContain("--session-id");
    expect(launch.args.at(-2)).toBe("--");
    expect(launch.args.at(-1)).toBe(`@${join(firstDirectory, "prompt.txt")}`);
    const explicitExtensions = launch.args.flatMap((argument: string, index: number) =>
      argument === "-e" ? [launch.args[index + 1]] : []);
    expect(explicitExtensions[0]).toMatch(/child-extension\.ts$/);
    expect(explicitExtensions[1]).toBe(providerExtension);

    for (const directory of [firstDirectory, secondDirectory]) {
      if (process.platform !== "win32") expect(mode(directory)).toBe(0o700);
      for (const file of ["manifest.json", "prompt.txt", "system-prompt.txt", "launch.json"]) {
        expect(existsSync(join(directory, file))).toBe(true);
        if (process.platform !== "win32") expect(mode(join(directory, file))).toBe(0o600);
      }
    }
  });

  it("uses the installed Pi dist CLI, automatic mode and an explicit Bash supervisor by default", () => {
    const root = temp("terminal-default-launch");
    const selectedPolicy = policy(root, { tools: [] });
    const selectedConfig = {
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      artifactDir: join(root, "runs"),
    };
    const reference = createTerminalSession(selectedPolicy, selectedConfig);
    const plan = prepareTerminalLaunch(selectedPolicy, reference, "default-run", endpoint(), "task", selectedConfig);
    const launch = json(join(dirname(plan.launchScriptFile), "launch.json"));

    expect(launch.executable).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/);
    expect(launch.args).toContain("--no-tools");
    expect(launch.args).not.toContain("--mode");
    expect(plan.interpreter).toBe("bash");
    expect(plan.buildCommand("surface ignored")).toMatch(/^exec '.*' '.*launch-process\.mjs' '.*launch\.json'$/);
  });

  it("quotes Bash and PowerShell supervisor paths without interpolating surface or artifact values", () => {
    const base = temp("terminal-command-quotes");
    const root = join(base, "directory with ' quote");
    mkdirSync(root);
    const selectedPolicy = policy(root);

    const bashConfig = config(root);
    const bashReference = createTerminalSession(selectedPolicy, bashConfig);
    const bashPlan = prepareTerminalLaunch(selectedPolicy, bashReference, "bash-run", endpoint(), "task", bashConfig);
    const bashSurface = "surface; touch /tmp/nope";
    const bashCommand = bashPlan.buildCommand(bashSurface);
    expect(JSON.parse(json(join(dirname(bashPlan.launchScriptFile), "launch.json")).env[TERMINAL_RENAME_CONTEXT_ENV])).toMatchObject({
      version: 1, surface: bashSurface,
    });
    expect(bashCommand).toContain("'\\''");
    expect(bashCommand).not.toContain("surface; touch");
    expect(bashCommand.startsWith("exec '")).toBe(true);

    const powerShellConfig = config(root, { interpreter: "powershell" });
    const psPlan = prepareTerminalLaunch(selectedPolicy, bashReference, "ps-run", endpoint(), "task", powerShellConfig);
    const psSurface = "$env:BAD='yes'";
    const psCommand = psPlan.buildCommand(psSurface);
    expect(JSON.parse(json(join(dirname(psPlan.launchScriptFile), "launch.json")).env[TERMINAL_RENAME_CONTEXT_ENV])).toMatchObject({
      version: 1, surface: psSurface,
    });
    expect(psPlan.launchScriptFile).toMatch(/launch\.ps1$/);
    expect(psCommand.startsWith("& '")).toBe(true);
    expect(psCommand).toContain("'' quote");
    expect(psCommand).toMatch(/; exit \$LASTEXITCODE$/);
    expect(psCommand).not.toContain("$env:BAD");
  });

  it("rejects invalid config and references before creating artifact directories", () => {
    const root = temp("terminal-invalid-launch");
    const selectedPolicy = policy(root);
    const reference: PersistentSessionReference<"terminal"> = {
      backend: "terminal",
      sessionId: "session",
      sessionFile: join(root, "session.jsonl"),
    };
    const artifactDir = join(root, "must-not-exist");

    expect(() => prepareTerminalLaunch(selectedPolicy, reference, "run", endpoint(), "task", {
      ...config(root),
      artifactDir,
      startupTimeoutMs: 0,
    })).toThrow();
    expect(existsSync(artifactDir)).toBe(false);

    expect(() => prepareTerminalLaunch(selectedPolicy, reference, "run", {
      ...endpoint(), host: "0.0.0.0",
    } as any, "task", { ...config(root), artifactDir })).toThrow();
    expect(existsSync(artifactDir)).toBe(false);
  });
});
