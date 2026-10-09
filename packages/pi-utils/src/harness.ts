export interface OwnedRegistration<T = unknown> {
  owner: string;
  name: string;
  value: T;
}

export interface RegisteredEvent {
  owner: string;
  event: string;
  handler: (...args: any[]) => unknown;
}

export interface ExtensionRegistrationHarness {
  api: any;
  commands: Map<string, OwnedRegistration>;
  tools: Map<string, OwnedRegistration>;
  shortcuts: Map<string, OwnedRegistration>;
  entryRenderers: Map<string, OwnedRegistration>;
  messageRenderers: Map<string, OwnedRegistration>;
  flags: Map<string, OwnedRegistration>;
  events: RegisteredEvent[];
  messages: Array<{ owner: string; value: unknown }>;
  entries: Array<{ owner: string; type: string; data: unknown }>;
  load(owner: string, factory: (api: any) => unknown | Promise<unknown>): Promise<void>;
}

/** Captures extension registrations and throws immediately on ownership collisions. */
export function createExtensionRegistrationHarness(): ExtensionRegistrationHarness {
  let currentOwner = "unowned";
  const commands = new Map<string, OwnedRegistration>();
  const tools = new Map<string, OwnedRegistration>();
  const shortcuts = new Map<string, OwnedRegistration>();
  const entryRenderers = new Map<string, OwnedRegistration>();
  const messageRenderers = new Map<string, OwnedRegistration>();
  const flags = new Map<string, OwnedRegistration>();
  const events: RegisteredEvent[] = [];
  const messages: Array<{ owner: string; value: unknown }> = [];
  const entries: Array<{ owner: string; type: string; data: unknown }> = [];
  const busHandlers = new Map<string, Set<(...args: any[]) => unknown>>();
  let activeTools: string[] = [];

  function register<T>(map: Map<string, OwnedRegistration>, name: string, value: T): void {
    const existing = map.get(name);
    if (existing) {
      throw new Error(`${currentOwner} attempted to replace ${existing.owner}'s registration "${name}"`);
    }
    map.set(name, { owner: currentOwner, name, value });
  }

  const baseApi: Record<PropertyKey, unknown> = {
    on(event: string, handler: (...args: any[]) => unknown) {
      const registration = { owner: currentOwner, event, handler };
      events.push(registration);
      return () => {
        const index = events.indexOf(registration);
        if (index >= 0) events.splice(index, 1);
      };
    },
    events: {
      on(event: string, handler: (...args: any[]) => unknown) {
        const handlers = busHandlers.get(event) ?? new Set();
        handlers.add(handler);
        busHandlers.set(event, handlers);
        return () => handlers.delete(handler);
      },
      async emit(event: string, payload: unknown) {
        for (const handler of busHandlers.get(event) ?? []) await handler(payload);
      },
    },
    registerCommand(name: string, value: unknown) {
      register(commands, name, value);
    },
    registerTool(value: { name: string }) {
      register(tools, value.name, value);
    },
    registerShortcut(key: unknown, value: unknown) {
      register(shortcuts, stableKey(key), value);
    },
    registerEntryRenderer(name: string, value: unknown) {
      register(entryRenderers, name, value);
    },
    registerMessageRenderer(name: string, value: unknown) {
      register(messageRenderers, name, value);
    },
    registerFlag(name: string, value: unknown) {
      register(flags, name, value);
    },
    getFlag() {
      return undefined;
    },
    getCommands() {
      return [...commands.values()].map((entry) => ({ name: entry.name, source: entry.owner }));
    },
    getAllTools() {
      return [...tools.values()].map((entry) => entry.value);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ owner: currentOwner, type, data });
    },
    sendMessage(value: unknown) {
      messages.push({ owner: currentOwner, value });
    },
    sendUserMessage(value: unknown) {
      messages.push({ owner: currentOwner, value });
    },
  };

  const api = new Proxy(baseApi, {
    get(target, property) {
      if (property in target) return target[property];
      return () => undefined;
    },
  });

  return {
    api,
    commands,
    tools,
    shortcuts,
    entryRenderers,
    messageRenderers,
    flags,
    events,
    messages,
    entries,
    async load(owner, factory) {
      const previousOwner = currentOwner;
      currentOwner = owner;
      try {
        await factory(api);
      } finally {
        currentOwner = previousOwner;
      }
    },
  };
}

function stableKey(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
