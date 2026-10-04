/**
 * isolated-provider.e2e.test.ts — Pi 0.87.1 ModelRegistry/runtime reachability.
 *
 * Child SDK sessions accept `modelRuntime`, while ExtensionContext exposes the
 * synchronous `modelRegistry` facade. agent-runner forwards the wrapped runtime
 * so isolated children retain extension-registered providers and authentication.
 *
 * The unit test covers forwarding with a double. This test pins the one private
 * reachability assumption against the installed Pi 0.87.1 implementation:
 * `.runtime` is the exact ModelRuntime used to construct the facade.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Pi 0.87.1 ModelRegistry runtime reachability", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    // A real, configured runtime — as an extension leaves it after registerProvider.
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });

    // `.runtime` is private and not in the package exports — reach the compiled
    // class by file path, exactly the field the patch's cast depends on. If Pi
    // moves/renames/#privates it, THIS line fails loudly instead of the fix
    // silently no-op'ing back to the #151 bug.
    const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const mrUrl = indexUrl.replace(/index\.js$/, "core/model-registry.js");
    const { ModelRegistry } = (await import(mrUrl)) as {
      ModelRegistry: new (rt: typeof runtime) => { runtime?: unknown };
    };

    const facade = new ModelRegistry(runtime);
    // This is the exact expression agent-runner reads (`ctx.modelRegistry.runtime`).
    expect((facade as { runtime?: unknown }).runtime).toBe(runtime);
  });
});
