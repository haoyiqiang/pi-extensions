/**
 * Shared layer-vocabulary for the workflow loader + validator.
 *
 * Lives in its own module so `load.ts` (loader / merge) and `validate-workflow.ts`
 * (issue attribution) can both reference the same union without a circular
 * import. `load.ts` depends on `validate-workflow.ts` for `validateWorkflow`, so
 * declaring `ConfigLayer` here keeps the dependency direction strict and
 * eliminates the silent-drift risk of two parallel string-literal unions.
 */

export type ConfigLayer = "built-in" | "user" | "project";

/**
 * Single source for layer → display string. Wrap every interpolation site
 * (`${layer}` in template strings, banner builders, issue prefixes) in this
 * helper; the `satisfies Record<ConfigLayer, string>` makes adding a new
 * `ConfigLayer` value a compile error here. The current display form is the
 * layer name verbatim — keep that invariant if you change it.
 */
const CONFIG_LAYER_LABELS = {
	"built-in": "built-in",
	user: "user",
	project: "project",
} satisfies Record<ConfigLayer, string>;

export function renderConfigLayer(layer: ConfigLayer): string {
	return CONFIG_LAYER_LABELS[layer];
}
