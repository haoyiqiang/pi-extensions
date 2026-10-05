# Explicit workflow prompt preparation

This extends the private managed workflow host; it does **not** register `/wf`,
discover project resources, load extensions or introduce production configuration.
The default remains plain-text-only. See [workflow execution](./workflow-execution.md)
for execution, saved-policy, cancellation and teardown contracts.

## Owner-supplied preparation

Both the provider and host accept an optional `preparePrompt` function:

```ts
type WorkflowPromptPreparer = (
  input: string,
  context: {
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly session?: PersistentSessionReference;
  },
) => PreparedWorkflowPrompt | Promise<PreparedWorkflowPrompt>;

interface PreparedWorkflowPrompt {
  readonly text: string;
  readonly requiredTools?: readonly string[];
  readonly resources?: readonly WorkflowPromptResource[];
}
```

Preparation runs exactly once for a fresh prompt or `sendUserMessage`, inside the
invocation admission limit and before backend dispatch. It does **not** run for the
ignored prompt of an idle reattach/fork. Restored children only prepare an input
when the callback explicitly sends a new message.

`cwd` is the workflow's canonical workspace. `session` is absent for fresh creation,
because the backend has not assigned its persistent identity. On a send it is the
actual persistent child reference, never a manager record or launcher ID. Context
and reference objects are frozen; the signal cancels this child scope.

The owner may supply asynchronous preparation, but must not treat it as an implicit
extension-input hook or authorization to discover resources/run commands. A late
result cannot dispatch after cancellation or callback closure. Uncooperative
preparation remains observed and retains its invocation capacity until it settles;
ordinary skill preparation below is synchronous and bounded.

Prepared text must be nonempty, at most **512 KiB of UTF-8**, and not begin with a
slash command. Tool requirements and provenance are validated, copied and frozen
before asynchronous backend preparation. A malformed result or leftover command
fails instead of falling back to the original text. Without a preparer, existing
plain-prompt validation and behavior remain unchanged.

The local child context exposes readonly `preparation`, the most recently prepared
input. It is **not** a completion or permission receipt. An idle restored child has
no inferred preparation metadata. Fresh preparation may fail tool admission without
being delivered to the model. Captured metadata is ordinary immutable data and
remains readable after scope closure.

## Approved skill snapshots

`createWorkflowSkillPreparer(approvals)` supplies a deterministic implementation.
The caller explicitly selects already-approved skill records; this helper never
walks directories, reads Pi configuration, infers project trust, or loads extension
factories. Public Pi `Skill` records can supply their name/path/base directory after
the owner has resolved discovery and trust.

Each approval contains:

| Field | Meaning |
| --- | --- |
| `name` | Unique portable lowercase skill name, at most 64 characters. |
| `filePath` | Absolute instruction-file path. |
| `baseDir` | Absolute existing directory used for relative references; independent of invocation CWD. |
| `format` | Required choice: `pi` or `positional-v1`; never guessed. |
| `requiredTools` | Optional exact minimum active tool names, not permission grants. |
| `expectedSha256` | Optional hash of the approved raw instruction-file bytes. |

Construction canonicalizes explicitly supplied symlinks, reads stable regular UTF-8
files and validates frontmatter/name/body. It snapshots the content and requirements;
later file edits or caller object mutation cannot retarget the snapshot. A supplied
hash must match. Relative input paths, duplicate names, malformed files and unknown
commands fail closed. No skill-name-to-filesystem fallback exists.

Bounds are **64 records**, **256 KiB per file**, and **2 MiB of total raw instruction
files**. Reads verify descriptor/path identity and nanosecond metadata before and
after reading. They do not follow a final-component replacement symlink or block
opening a swapped FIFO where the platform supports the corresponding flags. This
is cooperative local-filesystem validation, not an OS sandbox against an attacker
who can replace the directory hierarchy.

Only the instruction file is snapshotted. Supporting scripts, references and assets
remain at their approved base directory and can change. The SHA-256 identifies raw
file bytes, including frontmatter; it is not a hash of the complete resource bundle.
The prepared skill block contains localized location/provenance text, including its
hash and format, so those facts persist with the actual prompt in the raw transcript.
Paths in markup attributes are escaped; provenance separately preserves actual paths.

### Formats

Both formats accept `/skill:name` followed by raw arguments separated by whitespace.
Non-command plain text passes through; other slash commands and unapproved names
reject. Neither format executes preprocessing shell commands.

- **`pi`**: strips frontmatter and emits the instruction body literally, followed by
  raw arguments, matching Pi's *skill* argument model. Dollar tokens and shell-looking
  text are literal content, not an inferred template dialect.
- **`positional-v1`**: supports `$N`, `$ARGUMENTS`, `$@`, `${N:-default}`,
  `${ARGUMENTS:-default}`, `${@:-default}`, `${@:N}` and `${@:N:L}`, plus
  `${SKILL_DIR}` for the approved base directory. Quotes/whitespace follow the
  documented Pi 0.87.1 tokenization: no backslash escaping, empty tokens omitted,
  unclosed quotes tolerated. Unknown named variables remain literal.

`positional-v1` uses **one replacement pass**. Inserted argument/default text is
never interpreted again as a placeholder or shell program. Output bytes are counted
during expansion, not only after a potentially enormous replacement. The trailing
raw input is labelled separately from the skill body.

In `positional-v1`, source shell substitutions (`!` followed by backticks), shell
fences and `SESSION_ID` substitution are rejected. The fresh child ID is unavailable
at this preparation boundary; substituting the parent ID would be incorrect.

This is an explicitly versioned local format, **not byte-compatible `rpiv-args`**.
That extension also executes shell substitutions, injects a system-level protocol,
uses legacy sequential replacements and has display consumers tied to its literal
`Skill input:` label. We neither activate those hooks nor silently emulate them.
`/template` prompt-template registration/dispatch is also outside this profile.

## Tool admission

`requiredTools` is a per-invocation precondition, not a tool allowlist or grant. It
accepts up to 256 exact names of at most 256 UTF-16 code units each. Empty arrays and
undefined mean no requirement; names are deduplicated and frozen. Wildcards,
whitespace, control characters and invalid values reject.

For fresh managed runs, requirements are checked against the resolved policy **before
environment subprocess work, session creation or model execution**. For resume, they
are checked against the saved policy before writer reservation, capture reset or
prompt delivery. `StructuredOutput` counts as available only when that session's
schema policy actually installs it. Failure does not dirty the persisted source.

Requirements never load missing extensions, enable tools or retune saved policy.
For example, a skill declaring `Agent`, `ask_user_question` or `web_search` cannot run
under a builtin-only profile unless such a backend capability is explicitly added
later. The legacy embedded facade rejects nonempty requirements rather than ignoring
this managed-only capability. Manager queues snapshot requirements before yielding.

The owner must declare genuine requirements: arbitrary Markdown cannot reliably tell
us every tool a skill may use. Experimental `allowed-tools` frontmatter is **not**
reinterpreted as a required-tool list or permission grant. Skill content and arguments
can still contain prompt injection; these checks do not make model actions safe or
confine filesystem/network access.

## Development example

These are private source APIs. `selectedSkill` and `approvedDigest` come from the
owner's approval/discovery process; paths are not derived from model input.

```ts
const preparePrompt = createWorkflowSkillPreparer([{
  name: selectedSkill.name,
  filePath: selectedSkill.filePath,
  baseDir: selectedSkill.baseDir,
  format: "positional-v1",
  requiredTools: ["read"],
  expectedSha256: approvedDigest,
}]);
const provider = createWorkflowExecutionProvider({
  ...managedProviderOptions,
  preparePrompt,
});
const execution = provider.createHost(observer, runOptions);
try {
  await execution.host.spawnChild({
    prompt: `/skill:${selectedSkill.name} "source directory"`,
    withSession: async child => {
      const provenance = child.preparation?.resources;
      await child.sendUserMessage("Summarize the outstanding checks.");
      await child.waitForIdle();
      return { provenance, reference: child.reference };
    },
  });
} finally {
  await execution.close();
}
```

The same preparation contract is used by managed embedded and terminal. Terminal
provider/auth visibility, POSIX/Bash restrictions, saved-policy validation and lease
quarantine are unchanged. Actual consumer registration remains blocked on the
[cancellation/lifecycle contract](./workflow-consumer-contract.md), not on a hidden
local package import or global registration-slot workaround.
