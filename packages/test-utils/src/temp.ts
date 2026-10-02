import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function withTempAgentDir<T>(
  run: (agentDir: string) => T | Promise<T>,
  prefix = "pi-extension-test-",
): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  return withTempDir(prefix, async (agentDir) => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      return await run(agentDir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
}
