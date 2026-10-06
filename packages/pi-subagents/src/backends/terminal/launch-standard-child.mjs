import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = requireFromPi("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
await jiti.import(fileURLToPath(new URL("./standard-child.ts", import.meta.url)));
