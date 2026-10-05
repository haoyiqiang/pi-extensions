import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreparedWorkflowPrompt, WorkflowPromptPreparer } from "../src/workflow/prompt-preparation.js";
import { createWorkflowSkillPreparer, WORKFLOW_SKILL_RESOLVER_ID, type WorkflowSkillApproval } from "../src/workflow/skill-resources.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-binding-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function approval(name = "review", raw = "Snapshot instructions."): WorkflowSkillApproval {
  const baseDir = join(root, name);
  mkdirSync(baseDir, { recursive: true });
  const filePath = join(baseDir, "SKILL.md");
  writeFileSync(filePath, raw);
  return { name, filePath, baseDir, format: "pi" };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function prepare(callable: WorkflowPromptPreparer): PreparedWorkflowPrompt {
  return callable("/skill:review", { cwd: root, signal: new AbortController().signal }) as PreparedWorkflowPrompt;
}

describe("complete approved skill-set identity", () => {
  it("publishes frozen snapshot metadata and versioned resolver/asset semantics while remaining callable", () => {
    const input = approval();
    input.requiredTools = ["read", "bash", "read"];
    const preparer = createWorkflowSkillPreparer([input]);
    const callable: WorkflowPromptPreparer = preparer;
    expect(prepare(callable).text).toContain("Snapshot instructions.");
    expect(preparer.promptBinding).toEqual({ resolverId: WORKFLOW_SKILL_RESOLVER_ID,
      assetMode: "live", resourceSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(preparer.resources).toEqual([{ kind: "skill", name: input.name, filePath: input.filePath, baseDir: input.baseDir,
      sha256: hash("Snapshot instructions."), format: "pi", requiredTools: ["bash", "read"] }]);
    expect(preparer.promptBinding.resourceSetDigest).toBe(hash(JSON.stringify({
      version: 1, resolverId: WORKFLOW_SKILL_RESOLVER_ID, assetMode: "live", resources: preparer.resources,
    })));
    for (const object of [preparer, preparer.promptBinding, preparer.resources, preparer.resources[0], preparer.resources[0].requiredTools]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
  });

  it("sorts names and requirement sets independently of approval order, duplicates or empty declarations", () => {
    const first = { ...approval("zeta"), requiredTools: ["read", "bash", "read"] };
    const second = approval("alpha");
    const original = createWorkflowSkillPreparer([first, second]);
    const reordered = createWorkflowSkillPreparer([{ ...second, requiredTools: [] }, { ...first, requiredTools: ["bash", "read"] }]);
    expect(original.resources.map(resource => resource.name)).toEqual(["alpha", "zeta"]);
    expect(reordered.resources).toEqual(original.resources);
    expect(reordered.promptBinding).toEqual(original.promptBinding);
    const sha = hash("Snapshot instructions.");
    expect(createWorkflowSkillPreparer([{ ...first, expectedSha256: sha.toUpperCase() }, second]).promptBinding).toEqual(original.promptBinding);
  });

  it.each(["name", "filePath", "baseDir", "rawBytes", "format", "requiredTools"] as const)("changes identity when %s changes", field => {
    const original = approval();
    const before = createWorkflowSkillPreparer([original]);
    let changed = { ...original };
    if (field === "name") changed.name = "renamed";
    if (field === "filePath") {
      changed.filePath = join(root, "copied-SKILL.md");
      writeFileSync(changed.filePath, "Snapshot instructions.");
    }
    if (field === "baseDir") changed.baseDir = root;
    if (field === "rawBytes") writeFileSync(original.filePath, "Snapshot instructions.\r\n");
    if (field === "format") changed.format = "positional-v1";
    if (field === "requiredTools") changed.requiredTools = ["read"];
    const after = createWorkflowSkillPreparer([changed]);
    expect(after.promptBinding.resourceSetDigest).not.toBe(before.promptBinding.resourceSetDigest);
  });

  it("binds all approvals, not just the resource used by the current invocation", () => {
    const used = approval();
    const uncalled = approval("uncalled");
    const one = createWorkflowSkillPreparer([used]);
    const two = createWorkflowSkillPreparer([used, uncalled]);
    expect(prepare(one)).toEqual(prepare(two));
    expect(two.promptBinding).not.toEqual(one.promptBinding);
  });

  it("keeps identity stable after snapshot mutation attempts, file edits and live asset changes", () => {
    const requiredTools = ["read"];
    const selected = { ...approval(), requiredTools };
    const approvals = [selected];
    const preparer = createWorkflowSkillPreparer(approvals);
    const binding = { ...preparer.promptBinding };
    const resources = structuredClone(preparer.resources);
    const output = prepare(preparer);
    writeFileSync(selected.filePath, "Edited instruction file.");
    writeFileSync(join(selected.baseDir, "asset.txt"), "A live asset not included in this digest.");
    requiredTools.push("write");
    selected.name = "mutated";
    selected.baseDir = root;
    approvals.length = 0;
    expect(preparer.promptBinding).toEqual(binding);
    expect(preparer.resources).toEqual(resources);
    expect(prepare(preparer)).toEqual(output);
    expect(() => (preparer.promptBinding as { resolverId: string }).resolverId = "changed").toThrow();
    expect(() => (preparer.resources[0].requiredTools as string[]).push("write")).toThrow();
    expect(() => Object.assign(preparer, { promptBinding: {} })).toThrow();
  });

  it("uses canonical paths so explicitly approved aliases have the same identity", () => {
    const selected = approval();
    const alias = join(root, "alias");
    symlinkSync(selected.baseDir, alias, "dir");
    const canonical = createWorkflowSkillPreparer([selected]);
    const linked = createWorkflowSkillPreparer([{ ...selected, baseDir: alias, filePath: join(alias, "SKILL.md") }]);
    expect(linked.promptBinding).toEqual(canonical.promptBinding);
    expect(linked.resources).toEqual(canonical.resources);
  });

  it("has a stable explicit identity even for an empty approved set", () => {
    const first = createWorkflowSkillPreparer([]);
    const second = createWorkflowSkillPreparer([]);
    expect(first.resources).toEqual([]);
    expect(second.promptBinding).toEqual(first.promptBinding);
    expect(first.promptBinding.resourceSetDigest).toBe(hash(JSON.stringify({
      version: 1, resolverId: WORKFLOW_SKILL_RESOLVER_ID, assetMode: "live", resources: [],
    })));
    expect(first("plain text", { cwd: root, signal: new AbortController().signal })).toEqual({ text: "plain text" });
  });
});
