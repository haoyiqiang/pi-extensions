/**
 * Shared construction-time opts guard for the collector factories.
 *
 * Collector factories validate their opts eagerly (at workflow-definition
 * time) so a malformed option fails loudly where the author wrote it, not
 * as a confusing collect-time fatal mid-run. Each factory states the
 * requirement once; this helper keeps the throw wording uniform.
 */
export function requireOpt(factory: string, name: string, requirement: string, ok: boolean): void {
	if (!ok) throw new Error(`${factory}: \`${name}\` ${requirement}`);
}
