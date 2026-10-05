import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../src/i18n.js";
import { MAX_PREPARED_PROMPT_BYTES, type PreparedWorkflowPrompt, type WorkflowPromptPreparer } from "../src/workflow/prompt-preparation.js";
import { createWorkflowSkillPreparer, type WorkflowSkillApproval } from "../src/workflow/skill-resources.js";

// Copies make built-in operations spyable for deterministic in-read identity changes.
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>() }));

const FILE_LIMIT = 256 * 1024;
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const diagnostic = (key: string, name?: string) => i18n.t(`workflowResources.${key}`, name === undefined ? undefined : { name });

describe("explicit approved workflow skill snapshots", () => {
  let root: string;
  let sequence: number;
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "workflow-skills-"));
    sequence = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function approve(body: string | Buffer = "Instructions.", overrides: Partial<WorkflowSkillApproval> = {}): WorkflowSkillApproval {
    const baseDir = join(root, `fixture-${sequence++}`);
    fs.mkdirSync(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    fs.writeFileSync(filePath, body);
    return { name: "review", filePath, baseDir, format: "pi", ...overrides };
  }

  function invoke(prepare: WorkflowPromptPreparer, text = "/skill:review"): PreparedWorkflowPrompt {
    const result = prepare(text, { cwd: join(root, "unrelated-nonexistent-cwd"), signal: new AbortController().signal });
    expect(result).not.toBeInstanceOf(Promise);
    return result as PreparedWorkflowPrompt;
  }

  function bodyOf(prepared: PreparedWorkflowPrompt): string {
    return prepared.text.slice(prepared.text.indexOf("\n\n") + 2, prepared.text.lastIndexOf("\n</skill>"));
  }

  it("snapshots instruction bytes, approvals, tools, and metadata before any invocation", () => {
    const original = "---\nname: review\ndescription: Review safely.\n---\nOriginal instructions.";
    const tools = ["read", "read", "bash"];
    const approved = approve(original, { requiredTools: tools });
    const approvals = [approved];
    const prepare = createWorkflowSkillPreparer(approvals);
    const initial = invoke(prepare);
    expect(initial.resources).toEqual([{ kind: "skill", name: "review", filePath: fs.realpathSync(approved.filePath),
      baseDir: fs.realpathSync(approved.baseDir), sha256: hash(original), format: "pi" }]);
    expect(initial.requiredTools).toEqual(["read", "bash"]);
    expect(initial.text).toContain(i18n.t("workflowResources.skillProvenance", { sha256: hash(original), format: "pi" }));
    expect(initial.text).toContain(hash(original));
    expect(initial.text).toContain("pi");
    fs.writeFileSync(approved.filePath, "New instructions.");
    tools.push("unknown-extension");
    approved.name = "changed";
    approved.baseDir = root;
    approved.format = "positional-v1";
    approved.requiredTools = ["write"];
    approvals.length = 0;
    expect(invoke(prepare)).toEqual(initial);
    fs.rmSync(approved.filePath);
    expect(invoke(prepare)).toEqual(initial);
    for (const value of [initial, initial.resources, initial.resources![0], initial.requiredTools]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => (initial.resources![0] as { name: string }).name = "other").toThrow();
    expect(() => (initial.requiredTools as string[]).push("write")).toThrow();
    expect(invoke(prepare)).toEqual(initial);
  });

  it("uses explicit canonical symlink locations and base-directory references, not invocation cwd", () => {
    const approved = approve("Read references/checklist.md; ${SKILL_DIR}/assets/input.txt.", { format: "positional-v1" });
    const alias = join(root, "approved-link");
    fs.symlinkSync(approved.baseDir, alias, "dir");
    const fileAlias = join(root, "approved-file.md");
    fs.symlinkSync(join(alias, "SKILL.md"), fileAlias);
    const prepare = createWorkflowSkillPreparer([{ ...approved, filePath: fileAlias, baseDir: alias }]);
    const result = prepare("/skill:review", {
      get cwd(): string { throw new Error("Invocation cwd must not be consulted"); },
      signal: new AbortController().signal,
    }) as PreparedWorkflowPrompt;
    const baseDir = fs.realpathSync(approved.baseDir);
    expect(result.resources![0].filePath).toBe(fs.realpathSync(approved.filePath));
    expect(result.resources![0].baseDir).toBe(baseDir);
    expect(result.text).toContain(i18n.t("workflowResources.skillReferences", { baseDir }));
    expect(bodyOf(result)).toBe(`Read references/checklist.md; ${baseDir}/assets/input.txt.`);
    fs.unlinkSync(fileAlias);
    expect(invoke(prepare)).toEqual(result);
  });

  it("accepts an explicitly different base directory and leaves supporting assets live", () => {
    const approved = approve("Read references/live.md and references/not-yet-created.md.");
    const baseDir = join(root, "separate-assets");
    fs.mkdirSync(join(baseDir, "references"), { recursive: true });
    const asset = join(baseDir, "references", "live.md");
    fs.writeFileSync(asset, "Original asset");
    const open = vi.spyOn(fs, "openSync");
    const prepare = createWorkflowSkillPreparer([{ ...approved, baseDir }]);
    expect(open.mock.calls.map(call => call[0])).toEqual([fs.realpathSync(approved.filePath)]);
    open.mockClear();
    const original = invoke(prepare);
    fs.writeFileSync(asset, "Asset changed after approval");
    expect(invoke(prepare)).toEqual(original);
    expect(open).not.toHaveBeenCalled();
    expect(original.resources![0].baseDir).toBe(fs.realpathSync(baseDir));
  });

  it("hashes raw UTF-8 bytes including BOM and CRLF, not parsed body or assets", () => {
    const raw = Buffer.from("\uFEFF---\r\nname: review\r\n---\r\nUnicode: 中文 café 😀.\r\n", "utf8");
    const approved = approve(raw, { expectedSha256: hash(raw).toUpperCase() });
    const prepared = invoke(createWorkflowSkillPreparer([approved]));
    expect(prepared.resources![0].sha256).toBe(hash(raw));
    expect(bodyOf(prepared)).toBe("Unicode: 中文 café 😀.");
    expect(() => createWorkflowSkillPreparer([{ ...approved, expectedSha256: "0".repeat(64) }]))
      .toThrow(diagnostic("digestMismatch", "review"));
  });

  it("escapes every XML attribute character in approved paths, preserving real path metadata", () => {
    const baseDir = join(root, `资源 & <tag> "double" 'single'`);
    fs.mkdirSync(baseDir);
    const filePath = join(baseDir, "SKILL.md");
    fs.writeFileSync(filePath, "Safe instructions.");
    const result = invoke(createWorkflowSkillPreparer([{ name: "review", filePath, baseDir, format: "pi" }]));
    const canonical = fs.realpathSync(filePath);
    const escaped = canonical.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    expect(result.text.split("\n")[0]).toBe(`<skill name="review" location="${escaped}">`);
    expect(result.resources![0].filePath).toBe(canonical);
  });

  it("leaves ordinary text byte-for-byte unchanged without attaching approved resources", () => {
    const prepare = createWorkflowSkillPreparer([approve()]);
    const text = "  Plain text\nincludes /skill:unknown and $1\t ";
    expect(invoke(prepare, text)).toEqual({ text });
    expect(Object.isFrozen(invoke(prepare, text))).toBe(true);
  });

  it.each([" ", "\t", "\n", "\r\n", " \t\n"])("accepts command delimiter %j and preserves raw argument interiors", delimiter => {
    const prepare = createWorkflowSkillPreparer([approve("Body with $1, $@ and ${SKILL_DIR}.")]);
    const args = '"two words"\t$1\n/skill:not-approved  end';
    const result = invoke(prepare, `/skill:review${delimiter}${args}`);
    expect(bodyOf(result)).toBe("Body with $1, $@ and ${SKILL_DIR}.");
    expect(result.text.endsWith(`</skill>\n\n${args}`)).toBe(true);
  });

  it("does not guess a dialect or interpret positional and shell-looking syntax in pi mode", () => {
    const source = "Literal $1 $@ $ARGUMENTS ${1:-default} ${SKILL_DIR} ${SESSION_ID} !`printf no`\n```!\necho no\n```";
    const result = invoke(createWorkflowSkillPreparer([approve(source)]), "/skill:review raw $1");
    expect(bodyOf(result)).toBe(source);
    expect(result.text.endsWith("</skill>\n\nraw $1")).toBe(true);
  });

  it.each(["/review", "/skill:", "/skill:Review", "/skill:review/foo", "/skill:review--bad", "/skill:review\u00a0args",
    "/skill:review\u0000", "/skill:review:other", "/skill:../review", "/skill:review_2", "/skill:-review", "/skill:review-",
    `/skill:${"a".repeat(65)}`, " \n/unapproved"])("rejects malformed or unsupported command %j", text => {
    expect(() => invoke(createWorkflowSkillPreparer([approve()]), text)).toThrow(diagnostic("unsupportedCommand"));
  });

  it("rejects unknown skills without implicit discovery or executing any integration", () => {
    const approved = approve();
    const discovered = join(root, ".pi", "skills", "unapproved");
    fs.mkdirSync(discovered, { recursive: true });
    fs.writeFileSync(join(discovered, "SKILL.md"), "Not approved.");
    const readdir = vi.spyOn(fs, "readdirSync");
    const cwd = vi.spyOn(process, "cwd");
    const calls = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"].map(name =>
      vi.spyOn(childProcess, name as "spawn").mockImplementation(() => { throw new Error("No shell allowed"); }));
    const network = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", network);
    const prepare = createWorkflowSkillPreparer([approved]);
    expect(() => invoke(prepare, "/skill:unapproved")).toThrow(diagnostic("unknownSkill", "unapproved"));
    expect(() => invoke(createWorkflowSkillPreparer([]), "/skill:review")).toThrow(diagnostic("unknownSkill", "review"));
    expect(bodyOf(invoke(prepare))).toBe("Instructions.");
    expect(readdir).not.toHaveBeenCalled();
    expect(cwd).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it("checks cancellation before input validation, command lookup, or any preparation work", () => {
    const prepare = createWorkflowSkillPreparer([approve()]);
    const abort = new AbortController();
    const reason = new Error("Owner cancelled");
    abort.abort(reason);
    for (const text of ["/skill:review", "/skill:unknown", "", "x".repeat(MAX_PREPARED_PROMPT_BYTES + 1)]) {
      expect(() => prepare(text, { cwd: root, signal: abort.signal })).toThrow(reason);
    }
  });

  it.each(["", "Review", "two words", "two--words", "-review", "review-", "review/name", "review_name", "review\n", "review\u2028", "技能", "a".repeat(65)])(
    "rejects ambiguous or malformed approved name %j", name => {
      expect(() => createWorkflowSkillPreparer([approve("Body", { name })])).toThrow(diagnostic("invalidApproval"));
    },
  );

  it("rejects duplicate names instead of choosing an approval by order", () => {
    expect(() => createWorkflowSkillPreparer([approve("First"), approve("Second")])).toThrow(diagnostic("duplicateSkill", "review"));
  });

  it("requires absolute input paths, explicit format, and a well-formed expected digest", () => {
    const approved = approve();
    for (const invalid of [
      { filePath: relative(process.cwd(), approved.filePath) }, { baseDir: "." }, { filePath: "~/SKILL.md" },
      { filePath: `${approved.filePath}\n` }, { baseDir: `${approved.baseDir}\u0000` }, { format: undefined },
      { format: "rpiv-args" }, { expectedSha256: "not-a-sha256" }, { expectedSha256: `${"a".repeat(64)}\n` }, { expectedSha256: 1 },
    ]) expect(() => createWorkflowSkillPreparer([{ ...approved, ...invalid } as WorkflowSkillApproval])).toThrow(diagnostic("invalidApproval"));
    for (const invalid of [undefined, null, {}, [null], Array(1)]) {
      expect(() => createWorkflowSkillPreparer(invalid as unknown as WorkflowSkillApproval[])).toThrow(diagnostic("invalidApproval"));
    }
  });

  it("rejects missing/non-regular files, broken symlinks, and non-directory bases", () => {
    const approved = approve();
    const missing = join(root, "missing");
    const broken = join(root, "broken");
    fs.symlinkSync(missing, broken);
    for (const invalid of [{ filePath: missing }, { filePath: root }, { filePath: broken }, { baseDir: missing }, { baseDir: approved.filePath }]) {
      expect(() => createWorkflowSkillPreparer([{ ...approved, ...invalid }])).toThrow(diagnostic("invalidSkillFile"));
    }
  });

  it.each([Buffer.from([0xc3, 0x28]), Buffer.from([0xff]), Buffer.from([0xe2, 0x82]), Buffer.from([0xc0, 0xaf])])(
    "rejects malformed UTF-8 %j instead of silently replacing bytes", raw => {
      expect(() => createWorkflowSkillPreparer([approve(raw)])).toThrow(diagnostic("invalidSkillFile"));
    },
  );

  it.each(["", " \n\t", "---\nname: review", "---invalid\nname: review\n---\nBody", "---\nname: review\n---invalid\nBody",
    "---\nname: [broken\n---\nBody", "---\n- list\n---\nBody", "---\nscalar\n---\nBody",
    "---\nname: review\nname: review\n---\nBody", "---\nname: other\n---\nBody", "---\nname: 1\n---\nBody", "---\nname: review\n---\n"])(
    "rejects malformed frontmatter, mismatching names, and empty bodies %j", source => {
      expect(() => createWorkflowSkillPreparer([approve(source)])).toThrow(diagnostic("invalidSkillContent", "review"));
    },
  );

  it("accepts name-optional or empty frontmatter without importing allowed-tools as a grant", () => {
    const result = invoke(createWorkflowSkillPreparer([approve("---\ndescription: Explicit instruction.\nallowed-tools: [arbitrary-extension]\n---\nBody")]));
    expect(bodyOf(result)).toBe("Body");
    expect(result.requiredTools).toBeUndefined();
    expect(bodyOf(invoke(createWorkflowSkillPreparer([approve("---\n---\nBody")])))).toBe("Body");
  });

  it("enforces UTF-8 byte file bounds, including frontmatter", () => {
    const approved = approve("é".repeat(FILE_LIMIT / 2));
    expect(bodyOf(invoke(createWorkflowSkillPreparer([approved])))).toHaveLength(FILE_LIMIT / 2);
    fs.appendFileSync(approved.filePath, "é");
    expect(() => createWorkflowSkillPreparer([approved])).toThrow(diagnostic("invalidSkillFile"));
    const largeFrontmatter = approve(`---\ndescription: ${"x".repeat(FILE_LIMIT)}\n---\nTiny body`);
    expect(() => createWorkflowSkillPreparer([largeFrontmatter])).toThrow(diagnostic("invalidSkillFile"));
  });

  it("enforces 64 resource and 2 MiB cumulative raw-byte limits at construction", () => {
    const small = approve("x");
    const approvals = Array.from({ length: 64 }, (_, index) => ({ ...small, name: `skill-${index}` }));
    expect(invoke(createWorkflowSkillPreparer(approvals), "/skill:skill-63").resources![0].name).toBe("skill-63");
    const open = vi.spyOn(fs, "openSync");
    expect(() => createWorkflowSkillPreparer([...approvals, { ...small, name: "too-many" }])).toThrow(diagnostic("resourceLimit"));
    expect(open).not.toHaveBeenCalled();
    const large = approve("x".repeat(FILE_LIMIT));
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...large, name: `large-${index}` }));
    expect(createWorkflowSkillPreparer(eight)).toBeTypeOf("function");
    expect(() => createWorkflowSkillPreparer([...eight, { ...small, name: "one-byte-over" }])).toThrow(diagnostic("resourceLimit"));
  });

  it("rejects an inode replaced during a bounded read and closes the original descriptor", () => {
    const approved = approve("Original body");
    const actualRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(actualRead, fs, args);
      fs.renameSync(approved.filePath, `${approved.filePath}.original`);
      fs.writeFileSync(approved.filePath, "Replaced body");
      return count;
    }) as typeof fs.readSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => createWorkflowSkillPreparer([approved])).toThrow(diagnostic("invalidSkillFile"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a file grown during a bounded read", () => {
    const approved = approve("Original body");
    const actualRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(actualRead, fs, args);
      fs.appendFileSync(approved.filePath, " extra");
      return count;
    }) as typeof fs.readSync);
    expect(() => createWorkflowSkillPreparer([approved])).toThrow(diagnostic("invalidSkillFile"));
  });

  describe("positional-v1 (Pi 0.87.1 syntax, one replacement pass)", () => {
    function positional(source: string, args = ""): PreparedWorkflowPrompt {
      return invoke(createWorkflowSkillPreparer([approve(source, { format: "positional-v1" })]), `/skill:review ${args}`);
    }

    it("handles quoted tokens, arbitrary whitespace, all arguments, and a localized raw-input suffix", () => {
      const args = `one\t"two three"\n'four five' six`;
      const result = positional("$1 | $2 | $3 | $4 | $5 | $@ | $ARGUMENTS", args);
      expect(bodyOf(result)).toBe("one | two three | four five | six |  | one two three four five six | one two three four five six");
      expect(result.text.endsWith(`</skill>\n\n${i18n.t("workflowResources.skillInput")}\n${args}`)).toBe(true);
      expect(result.resources![0].format).toBe("positional-v1");
      expect(result.text).toContain("positional-v1");
    });

    it("matches Pi's empty-token, concatenated-quote, unclosed-quote, and literal-backslash rules", () => {
      expect(bodyOf(positional("$1 | $2 | $3 | $4", `"" '' pre"middle space"post a\\ b 'unclosed rest`)))
        .toBe("premiddle spacepost | a\\ | b | unclosed rest");
    });

    it("supports positional/all defaults and slices including zero start and zero length", () => {
      expect(bodyOf(positional("${1:-first}|${2:-second}|${@:-all}|${ARGUMENTS:-all-alias}")))
        .toBe("first|second|all|all-alias");
      expect(bodyOf(positional("${@:0:2}|${@:2}|${@:2:0}|${@:20}|${@:2:3}|$0|$10|${0:-zero}|${12:-fallback}", "a b c d e f g h i j k")))
        .toBe("a b|b c d e f g h i j k|||b c d||j|zero|fallback");
      expect(bodyOf(positional("${1:-first}|${@:-all}|${ARGUMENTS:-all-alias}", "actual words")))
        .toBe("actual|actual words|actual words");
    });

    it("does not recursively substitute hostile arguments, defaults, or command-looking expanded text", () => {
      const hostile = '${SKILL_DIR} $2 $@ ${SESSION_ID} !`not-executed` /skill:unapproved';
      const result = positional("$1\n$@\n$ARGUMENTS", `'${hostile}'`);
      expect(bodyOf(result)).toBe([hostile, hostile, hostile].join("\n"));
      expect(bodyOf(positional("${1:-$2 $@ ${SKILL_DIR}}"))).toBe("$2 $@ ${SKILL_DIR}");
      expect(bodyOf(positional("$1", "/skill:not-approved"))).toBe("/skill:not-approved");
      expect(bodyOf(positional("$1", '"```!\nnot-executed\n```"'))).toBe("```!\nnot-executed\n```");
    });

    it("does not recursively interpret SKILL_DIR and leaves unknown variables literal", () => {
      const baseDir = join(root, "$1-${SESSION_ID}");
      fs.mkdirSync(baseDir);
      const filePath = join(baseDir, "SKILL.md");
      fs.writeFileSync(filePath, "${SKILL_DIR}|$UNKNOWN|${UNKNOWN}|$ARGUMENTS_EXTRA|${1}|${@:bad}|${2:+$1}|${UNKNOWN:-$1}");
      const result = invoke(createWorkflowSkillPreparer([{ name: "review", filePath, baseDir, format: "positional-v1" }]), "/skill:review argument");
      expect(bodyOf(result)).toBe(`${fs.realpathSync(baseDir)}|$UNKNOWN|\${UNKNOWN}|$ARGUMENTS_EXTRA|\${1}|\${@:bad}|\${2:+$1}|\${UNKNOWN:-$1}`);
    });

    it("preserves unclosed unknown variables without repeatedly scanning the remaining source", () => {
      const source = "${".repeat(10_000);
      expect(bodyOf(positional(source, "unused"))).toBe(source);
    });

    it.each(["Run !`echo not-executed`", "```!\necho not-executed\n```", "```` !bash\necho not-executed\n````", "Use ${SESSION_ID}"])(
      "rejects unsupported source semantics during construction: %s", source => {
        expect(() => createWorkflowSkillPreparer([approve(source, { format: "positional-v1" })]))
          .toThrow(diagnostic("unsupportedSkillSyntax", "review"));
      },
    );

    it("rejects oversized input, final wrappers/suffixes, and amplification during replacement", () => {
      expect(() => positional("$1", "é".repeat(MAX_PREPARED_PROMPT_BYTES / 2)))
        .toThrow(diagnostic("invalidPreparation"));
      expect(() => positional("x".repeat(FILE_LIMIT), "a".repeat(FILE_LIMIT)))
        .toThrow(diagnostic("invalidPreparation"));
      expect(() => positional("$@ ".repeat(10_000), "b".repeat(10_000)))
        .toThrow(diagnostic("invalidPreparation"));
    });
  });
});
