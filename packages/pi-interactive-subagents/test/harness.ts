import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

/** The shared registration/lifecycle seam; no model or real terminal is involved. */
export function createMockExtensionApi() {
  const registeredTools: any[] = [];
  const registeredCommands: any[] = [];
  const registeredMessageRenderers: any[] = [];
  const sentUserMessages: string[] = [];
  const sentMessages: any[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  return {
    registeredTools, registeredCommands, registeredMessageRenderers,
    sentUserMessages, sentMessages,
    async emit(event: string, payload: any, ctx: any) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    tool(name: string) {
      const tool = registeredTools.find((tool) => tool.name === name);
      assert.ok(tool, `Expected registered native tool ${name}`);
      return tool;
    },
    api: {
      on(event: string, handler: (...args: any[]) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(tool: any) { registeredTools.push(tool); },
      registerCommand(name: string, command: any) { registeredCommands.push({ name, ...command }); },
      registerMessageRenderer(name: string, renderer: any) { registeredMessageRenderers.push({ name, renderer }); },
      registerShortcut() {},
      sendUserMessage(message: string) { sentUserMessages.push(message); },
      sendMessage(message: any, options?: any) { sentMessages.push({ message, options }); },
      getAllTools() { return registeredTools; },
    } as any,
  };
}

export const plainTheme = {
  fg(_color: string, text: string) { return text; },
  bg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
};

/** Bounded synchronization with an external fixture, not a guessed readiness sleep. */
export async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
