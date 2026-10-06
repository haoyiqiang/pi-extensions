import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStandardTerminalExecutionBackend } from "./backends/terminal/backend.js";
import { createEmbeddedExecutionBackend } from "./backends/embedded-adapter.js";
import { runAgent } from "./agent-runner.js";
import { i18n } from "./i18n.js";
import { createRoutedExecutionBackend, type RoutedExecutionBackend } from "./runtime.js";
import { loadSettings, type SubagentBackend } from "./settings.js";
import { resolveProjectTrusted } from "./project-trust.js";

/** All product entrypoints use this factory; managed isolation is a separate profile. */
export function createProductExecutionBackend(options: {
  cwd?: string;
  backend?: SubagentBackend;
} = {}): RoutedExecutionBackend {
  return createRoutedExecutionBackend({
    embedded: () => createEmbeddedExecutionBackend({
      runAgent(ctx, type, prompt, request) {
        if (request.interactive) {
          throw new Error(i18n.t("product.terminalRequired"));
        }
        return runAgent(ctx, type, prompt, request);
      },
    }),
    terminal: () => createStandardTerminalExecutionBackend(),
    selectBackend: (ctx?: ExtensionContext) => {
      const cwd = options.cwd ?? ctx?.cwd ?? process.cwd();
      return options.backend
        ?? loadSettings(cwd, { projectTrusted: resolveProjectTrusted(cwd, { context: ctx }) }).backend
        ?? "embedded";
    },
  });
}
