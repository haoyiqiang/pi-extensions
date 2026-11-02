# Superagent 实验记录：用 agent 完成一次纯文档改动

- **日期**：2026-11-02
- **仓库**：[haoyiqiang/pi-extensions](https://github.com/haoyiqiang/pi-extensions)
- **基线**：`main` 分支的提交 `b4b1dcf`
- **触发**：[issue #26](https://github.com/haoyiqiang/pi-extensions/issues/26)
- **工作分支**：`agent/add-experiment-doc-37b00d958f2f`

## 实验问题

当任务只要求“新增一个文档、不修改任何已有文件”时，一个由 GitHub issue 触发的 superagent（自动执行开发任务的 agent）能否独立完成改动，并且改动范围可以被客观验证？

本文件既是实验记录，也是实验产物：记录的是创建本文件的那一次 agent 运行。

## 假设

- **H1（只新增目标文件）**：运行结束后，工作区相对基线的唯一差异是新增 `docs/superagent-experiment.md`。
- **H2（不改已有文件）**：没有已跟踪文件被修改、删除或重命名。
- **H3（满足内容要求）**：文档覆盖 issue 要求的四项内容：假设、执行的命令、观察到的现象、结论。

H1、H2 由 git 状态判定；H3 通过阅读文档判定。

## 实验设置

- 任务来自 issue #26 正文；触发评论只是要求按正文执行，没有增加约束。
- 约束：只新增 `docs/superagent-experiment.md`，不改任何已有文件。
- Agent 按仓库 `AGENTS.md` 的约定使用 `gh` 读取 issue，并在独立 git worktree 的 `agent/add-experiment-doc-37b00d958f2f` 分支上工作。
- 基线为 `b4b1dcf`，实验开始时工作区干净。

## 执行的命令

以下命令按执行顺序摘录。命令输出为实际输出；文档内容通过编辑工具写入，不对应 shell 命令。

### 读取任务

```console
$ gh issue view 26 --repo haoyiqiang/pi-extensions --json number,title,state --jq '{number,title,state}'
{"number":26,"state":"OPEN","title":"docs: 记录一次 superagent 实验"}
```

issue 正文要求记录一次用 agent 完成文档改动的实验（假设、执行的命令、观察到的现象、结论），并且只新增 `docs/superagent-experiment.md`。

### 确认基线与改动范围起点

```console
$ git rev-parse --short HEAD && git branch --show-current
b4b1dcf
agent/add-experiment-doc-37b00d958f2f

$ git status --porcelain
```

`git status --porcelain` 无输出，说明实验开始时没有未提交的改动。

### 确认目标路径

```console
$ ls -A docs
agents
```

`docs/` 顶层只有 `agents/`，目标文件不存在，也没有需要同步更新的目录索引。

### 写入文件后检查

（用编辑工具创建 `docs/superagent-experiment.md`，然后执行：）

```console
$ git status --porcelain
?? docs/superagent-experiment.md

$ git add docs/superagent-experiment.md
$ git status --porcelain
A  docs/superagent-experiment.md

$ git diff --cached --name-status
A	docs/superagent-experiment.md

$ git diff --stat
```

`git diff --stat` 无输出，表示没有其他未暂存改动；暂存区里只有一个新增文件。

### 文本检查

```console
$ git diff --cached --check
```

无输出（退出码 0），没有行尾空白、冲突标记等问题。仓库没有 Markdown linter；完整的 `npm run check` 由 PR 上的 CI 执行。本次不修改代码，因此没有在本地运行整套测试。

本文定稿后，改动以 commit 的形式提交并通过 PR 交付；PR 的 checks 记录完整门禁结果。

## 观察到的现象

1. **触发文本没有额外约束。** 触发评论与 issue 正文一致，读取 issue 就能拿到完整任务；不存在只藏在评论里的要求。
2. **未跟踪文件对 `git diff` 不可见。** 新建文件刚写入时不会出现在 `git diff` 或 `git diff --stat` 中。只看这两条命令会误判为“没有改动”，因此必须用 `git status --porcelain`，或先 `git add` 再检查暂存区。
3. **`docs/` 没有索引文件。** 新增文档不需要改动 README 或其他目录页，纯文档任务的耦合面很小。
4. **CI 不按路径过滤。** `.github/workflows/ci.yml` 对每个 PR 运行 `npm run check`、npm 名称检查和 publish-health 检查；纯文档 PR 也会承担完整的代码门禁。因此本地只做与改动相关的检查，完整门禁以 PR 的 checks 为准。
5. **记录者与被试是同一个 agent。** 本记录由执行实验的 agent 撰写，存在自报偏差；上面的命令输出可以从分支和 PR 独立复核。

## 结论

在本次实验范围内，H1 和 H2 成立：agent 在独立分支上只新增了 `docs/superagent-experiment.md`，没有修改任何已有文件；H3 由文档中的假设、执行的命令、观察到的现象和结论四个部分满足。

对这类纯文档任务，最有区分度的验证是改动范围断言，而不是运行测试：`git status --porcelain` 应只包含目标路径，`git diff --stat` 应为空。这直接对应 issue 的约束“只新增这一个文件，不改任何已有文件”。

## 局限

- 只覆盖一个文件、一次运行，不能说明 agent 在代码改动、跨模块改动或需要设计判断的任务上的表现。
- 没有记录端到端耗时，也没有评估文档质量（可读性、准确性）的客观指标。
- 完整仓库门禁与评审结果不在本地实验的判定范围内，应以 PR 的 checks 和评审为准。

## 复现

1. 从 `main` 创建新分支。
2. 提出与 issue #26 相同的约束：只新增 `docs/superagent-experiment.md`。
3. 让 agent 完成后，运行：

```console
$ git status --porcelain
$ git diff --stat
```

预期：前者只有目标文件的一行状态，后者为空。
