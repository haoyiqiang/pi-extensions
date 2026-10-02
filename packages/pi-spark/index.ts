import { autoCollectEvents } from "./src/events";
import registerCleanMode from "./src/features/clean-mode";
import { registerCredits } from "./src/features/credits";
import { registerEditor } from "./src/features/editor";
import { registerFooter } from "./src/features/footer";
import { registerMetrics } from "./src/features/metrics";
import { registerPresets } from "./src/features/presets";
import { registerRecap } from "./src/features/recap";
import { registerSessionResources } from "./src/features/session-resources";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-spark is a single extension that bundles several features. Each feature registers itself
 * like a standalone extension and reads its config via the shared, cached `loadConfig`. This file
 * is just the registry that wires them together.
 */
export default function (pi: ExtensionAPI) {
  // Own the event-bus subscription lifecycle here so features never manage cleanup themselves;
  // the collector disposes every subscription on session_shutdown.
  const events = autoCollectEvents(pi);

  registerCleanMode(pi);
  registerCredits(pi);
  registerSessionResources(pi);
  registerEditor(pi, events);
  registerFooter(pi);
  registerMetrics(pi);
  registerPresets(pi);
  registerRecap(pi);
}
