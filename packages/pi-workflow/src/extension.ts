/**
 * Explicit private Pi entry; no Pi manifest activates it automatically.
 * The root index stays the programmatic engine API. This entry registers the
 * executor adapter, /wf, cancellation and docs; the run path remains lazy.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommand } from "./command.js";
import { registerDocsProtocol } from "./docs-protocol.js";
import { installPiWorkflowExecution, registerWorkflowCancellationCommand } from "./pi-execution.js";

export default function (pi: ExtensionAPI): void {
	const execution = installPiWorkflowExecution(pi);
	registerWorkflowCancellationCommand(pi, execution);
	registerWorkflowCommand({
		getCommands: () => pi.getCommands(),
		registerCommand: (name, command) => pi.registerCommand(name, {
			...command,
			handler: (args, ctx) => execution.runCommand(ctx, (observer) => command.handler(args, observer)),
		}),
	});
	registerDocsProtocol(pi);
}
