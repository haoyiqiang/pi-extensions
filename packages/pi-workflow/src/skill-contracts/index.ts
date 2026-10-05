/**
 * Skill-contract registry public surface. Internally split into four focused
 * modules (see `registry.ts`'s header for the module map); this barrel
 * re-exports only the symbols the rest of the package consumes.
 */

export {
	adjudicateChannel,
	type ChannelAdjudication,
	canCompose,
	compareDataChannel,
	legalNextSkills,
} from "./composition.js";
export {
	getBucketKindMappings,
	getCompositionComparators,
	getOutcomeDerivers,
	type OutcomeDeriverFn,
	registerBucketKindMapping,
	registerCompositionComparator,
	registerOutcomeDeriver,
} from "./extension-points.js";
export { buildEffectiveContracts, harvestStageContracts } from "./harvest.js";
export {
	drainSkillContractCollisions,
	drainSkillContractProviderErrors,
	flushSkillContractProviders,
	getSkillContracts,
	registerSkillContracts,
	registerSkillContractsProvider,
} from "./registry.js";

import { __resetExtensionPoints } from "./extension-points.js";
import { __resetContractRegistry } from "./registry.js";

/**
 * Test reset (wired into repo-wide setup). Clears the registry, pending lazy
 * providers, recorded failures + collisions, ownership map, comparator + deriver
 * registries, and the flush latch so the next case starts clean.
 */
export function __resetSkillContracts(): void {
	__resetContractRegistry();
	__resetExtensionPoints();
}
