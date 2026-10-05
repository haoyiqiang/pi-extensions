/**
 * Predicate helpers for `gate(...)` — small, side-effect-free combinators
 * over a single field value. Each helper returns a `NumericPredicate` that
 * the runtime evaluates against `Number(output.data[field])`.
 *
 * Numeric coercion via `Number(...)` matches the prior `threshold` semantics:
 * missing or non-numeric fields coerce to `NaN`, and `NaN` compares false
 * against any threshold. Callers wanting a non-default fall-through let
 * `gate`'s last-branch fallback handle the unmatched case.
 */

export type NumericPredicate = (value: number) => boolean;

/** @deprecated Renamed to `NumericPredicate` (the bare name collided with `EdgePredicate`-style route predicates). Ships for one release. */
export type Predicate = NumericPredicate;

/** Strictly greater than. */
export const gt =
	(n: number): NumericPredicate =>
	(v) =>
		v > n;

/** Greater than or equal. */
export const gte =
	(n: number): NumericPredicate =>
	(v) =>
		v >= n;

/** Strictly less than. */
export const lt =
	(n: number): NumericPredicate =>
	(v) =>
		v < n;

/** Less than or equal. */
export const lte =
	(n: number): NumericPredicate =>
	(v) =>
		v <= n;

/** Numeric equality (after `Number(...)` coercion of `output.data[field]`). */
export const eq =
	(n: number): NumericPredicate =>
	(v) =>
		v === n;
