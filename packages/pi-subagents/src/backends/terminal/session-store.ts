import type { EffectiveThinkingLevel } from "../../types.js";
import { ManagedSession } from "../managed-session.js";
import type { PersistentSessionReference } from "../session-reference.js";
import type { SessionWitness } from "../session-witness.js";
import type { ExecutionRestoreOptions } from "../types.js";
import { createTerminalSession, type TerminalBackendConfig, type TerminalPolicy } from "./prepare.js";

/** Terminal compatibility facade; seed creation still validates the complete terminal config. */
export class ManagedTerminalSession {
  readonly reference: PersistentSessionReference<"terminal">;
  private constructor(private readonly managed: ManagedSession<"terminal">) {
    this.reference = managed.reference;
  }
  get policy(): TerminalPolicy { return this.managed.policy; }

  static create(policy: TerminalPolicy, config: TerminalBackendConfig, source?: ManagedTerminalSession): ManagedTerminalSession {
    return new ManagedTerminalSession(ManagedSession.create(policy, (resolved) => createTerminalSession(resolved, config), source?.managed));
  }

  static open(reference: PersistentSessionReference, options: ExecutionRestoreOptions = {}): ManagedTerminalSession {
    return new ManagedTerminalSession(ManagedSession.open(reference, "terminal", options));
  }

  readReady() { return this.managed.readReady(); }
  beginRun(runId: string): void { this.managed.beginRun(runId); }
  checkpoint(thinkingLevel?: EffectiveThinkingLevel, witness?: SessionWitness): void {
    this.managed.checkpoint(thinkingLevel, witness);
  }
  quarantine(): void { this.managed.quarantine(); }
  fork(config: TerminalBackendConfig, options: ExecutionRestoreOptions = {}): ManagedTerminalSession {
    return new ManagedTerminalSession(this.managed.fork((policy) => createTerminalSession(policy, config), options));
  }
  release(): void { this.managed.release(); }
}
