/**
 * Invocation-local ownership fence for one logical workflow run.
 *
 * The execution backend may stop awaiting a child callback when cancellation
 * wins a race. That callback can still settle later, so `RunState.termination`
 * alone is not a sufficient admission check: a cancelled script may not have
 * reached a terminal writer yet, and a provider may retire while an abandoned
 * lifecycle callback is still suspended. The scope closes non-terminal writes
 * immediately when its signal aborts, admits exactly one terminal owner, and
 * can be sealed after executor retirement so every abandoned continuation is
 * permanently fenced out.
 */
export interface RunScope {
	readonly signal?: AbortSignal;
	/** Current graph-stage attribution for a run-body cancellation. */
	readonly activeStage?: string;
	/** Update cancellation attribution as the chain enters/routes a stage. */
	setActiveStage(name: string): void;
	/** True only while ordinary state mutation / journal appends are admitted. */
	isActive(): boolean;
	/** Claim the run's single terminal transition. Signal abortion does not bar
	 *  this claim: the abort writer itself must still persist the terminal row. */
	claimTerminal(): boolean;
	/** Permanently close the logical run after the runner's retirement barrier. */
	seal(): void;
}

class LogicalRunScope implements RunScope {
	private terminalClaimed = false;
	private sealed = false;
	activeStage?: string;

	constructor(readonly signal?: AbortSignal) {}

	setActiveStage(name: string): void {
		if (!this.sealed && !this.terminalClaimed) this.activeStage = name;
	}

	isActive(): boolean {
		return !this.sealed && !this.terminalClaimed && this.signal?.aborted !== true;
	}

	claimTerminal(): boolean {
		if (this.sealed || this.terminalClaimed) return false;
		this.terminalClaimed = true;
		return true;
	}

	seal(): void {
		this.sealed = true;
	}
}

export function createRunScope(signal?: AbortSignal): RunScope {
	return new LogicalRunScope(signal);
}
