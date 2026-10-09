/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * Adapted from NVlabs/SoL-Pi, extensions/action-fusion/then-run.ts.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { createBashToolDefinition, type BashToolDetails, type BashToolOptions, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFusedFileQueue } from "./file-queue.ts";

export const THEN_RUN_RUNNING = "[then_run:running]";
export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
  command: string;
  timeout?: number;
}

export interface ActionFusionDetails {
  actionFusion: {
    status: "running" | "succeeded";
    command: string;
    bashDetails?: BashToolDetails;
  };
}

export type FusedDetails<T> = T | (ActionFusionDetails & (T extends object ? T : object));

export function createThenRunSchema(description: string) {
  return Type.Optional(Type.Object({
    command: Type.String({ minLength: 1, description: "Bash command to run after a successful file mutation" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; omitted means no default timeout" })),
  }, { description }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resultText(result: AgentToolResult<unknown>): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted.");
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Best-effort interference check, not a filesystem lock against external writers. */
export async function assertUnchangedBeforeCommand(
  path: string,
  yieldForInterference: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
  signal?: AbortSignal,
): Promise<void> {
  try {
    throwIfAborted(signal);
    const mutationHash = await fileSha256(path);
    await yieldForInterference();
    throwIfAborted(signal);
    if (mutationHash !== await fileSha256(path)) throw new Error("Target content changed before the follow-up command.");
    throwIfAborted(signal);
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)} ${"The command was not run."}`);
  }
}

function combinedResult<T>(
  mutation: AgentToolResult<T>,
  commandResult: AgentToolResult<BashToolDetails | undefined>,
  command: string,
  status: "running" | "succeeded",
): AgentToolResult<FusedDetails<T>> {
  const marker = status === "running" ? THEN_RUN_RUNNING : THEN_RUN_SUCCEEDED;
  const output = resultText(commandResult);
  return {
    ...mutation,
    content: [...mutation.content, { type: "text", text: output ? `${marker}\n${output}` : marker }],
    details: {
      ...mutation.details,
      actionFusion: { status, command, bashDetails: commandResult.details },
    } as FusedDetails<T>,
  };
}

export async function executeMutationThenRun<T>({
  toolCallId, absolutePath, thenRun, mutate, bashOptions, signal, onUpdate, ctx,
}: {
  toolCallId: string;
  absolutePath: string;
  thenRun?: ThenRunInput;
  mutate: () => Promise<AgentToolResult<T>>;
  bashOptions?: BashToolOptions;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<FusedDetails<T>>;
  ctx: ExtensionContext;
}): Promise<AgentToolResult<FusedDetails<T>>> {
  // Validate before mutation, including direct programmatic calls outside schema validation.
  if (thenRun && (typeof thenRun.command !== "string" || !thenRun.command.trim())) {
    throw new Error("then_run.command must be a non-empty string.");
  }
  return withFusedFileQueue(absolutePath, async () => {
    let mutationResult: AgentToolResult<T>;
    try {
      throwIfAborted(signal);
      mutationResult = await mutate();
    } catch (error) {
      if (thenRun) throw new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${"The file mutation did not complete successfully; the command was not run."}`);
      throw error;
    }
    if (!thenRun) return mutationResult;
    try {
      await assertUnchangedBeforeCommand(absolutePath, undefined, signal);
    } catch (error) {
      throw new Error([resultText(mutationResult), errorText(error)].filter(Boolean).join("\n\n"));
    }
    const bash = createBashToolDefinition(ctx.cwd, bashOptions);
    try {
      // Show that the mutation is saved even when the command produces no data.
      onUpdate?.(combinedResult(mutationResult, { content: [], details: undefined }, thenRun.command, "running"));
      const bashResult = await bash.execute(
        `${toolCallId}:then_run`, thenRun, signal,
        onUpdate ? (partial) => onUpdate(combinedResult(mutationResult, partial, thenRun.command, "running")) : undefined,
        ctx,
      );
      return combinedResult(mutationResult, bashResult, thenRun.command, "succeeded");
    } catch (error) {
      // Pi marks thrown execution errors as failed tool results. The mutation is not rolled back.
      throw new Error([resultText(mutationResult), THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
    }
  });
}
