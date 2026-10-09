/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Adapted from NVlabs/SoL-Pi, extensions/action-fusion/index.ts.
 */
import { createEditToolDefinition, createWriteToolDefinition, type BashToolOptions, type EditToolDetails, type EditToolOptions, type ExtensionFactory, type WriteToolOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToolPath } from "./file-queue.ts";
import { fusionRenderers } from "./render.ts";
import { createThenRunSchema, executeMutationThenRun, type FusedDetails } from "./then-run.ts";

export interface ActionFusionOptions {
  /** Native operations/settings for deterministic tests and embedded runtimes. */
  bashOptions?: BashToolOptions;
  editOptions?: EditToolOptions;
  writeOptions?: WriteToolOptions;
}

function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
  const cache = new Map<string, T>();
  return (cwd) => {
    if (!cache.has(cwd)) cache.set(cwd, create(cwd));
    return cache.get(cwd)!;
  };
}

/** Programmatic factory is explicitly enabled; the package default entry checks configuration. */
export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
  const baseEdit = memoizeByCwd((cwd) => createEditToolDefinition(cwd, options.editOptions));
  const baseWrite = memoizeByCwd((cwd) => createWriteToolDefinition(cwd, options.writeOptions));
  return (pi) => {
    const edit = baseEdit(process.cwd());
    const write = baseWrite(process.cwd());
    const editParameters = Type.Object({
      ...edit.parameters.properties,
      then_run: createThenRunSchema("Optional command to run after this file edit succeeds, such as a test or build. A failed edit skips the command; a failed command keeps the edit. This command executes inside edit, not as a separate bash tool call."),
    });
    const writeParameters = Type.Object({
      ...write.parameters.properties,
      then_run: createThenRunSchema("Optional command to run after this file write succeeds, such as a test or build. A failed write skips the command; a failed command keeps the write. This command executes inside write, not as a separate bash tool call."),
    });
    pi.registerTool<typeof editParameters, FusedDetails<EditToolDetails | undefined>>({
      ...edit,
      parameters: editParameters,
      promptGuidelines: [...(edit.promptGuidelines ?? []), "Use then_run only when the follow-up command is already known and safe to run after this single-file mutation. Omit it when inspecting the edit result must come first."],
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        const { then_run, ...editInput } = input;
        return executeMutationThenRun({
          toolCallId, absolutePath: resolveToolPath(ctx.cwd, input.path), thenRun: then_run,
          bashOptions: options.bashOptions, signal, onUpdate, ctx,
          mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
        });
      },
      ...fusionRenderers(baseEdit),
    });
    pi.registerTool<typeof writeParameters, FusedDetails<undefined>>({
      ...write,
      parameters: writeParameters,
      promptGuidelines: [...(write.promptGuidelines ?? []), "Use then_run only when the follow-up command is already known and safe to run after this single-file mutation. Omit it when inspecting the edit result must come first."],
      async execute(toolCallId, input, signal, onUpdate, ctx) {
        const { then_run, ...writeInput } = input;
        return executeMutationThenRun({
          toolCallId, absolutePath: resolveToolPath(ctx.cwd, input.path), thenRun: then_run,
          bashOptions: options.bashOptions, signal, onUpdate, ctx,
          mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
        });
      },
      ...fusionRenderers(baseWrite),
    });
  };
}
