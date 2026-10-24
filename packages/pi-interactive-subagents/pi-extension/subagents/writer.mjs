// This gate runs BEFORE the Pi CLI can open, migrate or append its transcript.
// A claim outlives the controller. Neither lease expiry nor surface absence can
// release it. A killed wrapper leaves an uncertain claim, not a free writer.
import { openSync, closeSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [sessionFile, executionId, token, command] = process.argv.slice(2);
const owner = () => JSON.parse(readFileSync(`${sessionFile}.writer.json`, "utf8"));
const check = () => {
  const claim = owner();
  if (claim.executionId !== executionId || claim.token !== token) throw new Error("Stale subagent writer claim; Pi was not opened");
};
check();
// A duplicate native startup command must not run Pi OR publish an exit receipt
// for the original writer. This immutable gate is never reused for a new writer.
closeSync(openSync(`${sessionFile}.writer-started-${executionId}`, "wx", 0o600));
check();
const result = spawnSync("bash", ["-c", command], { stdio: "inherit", env: process.env });
if (result.status !== null && !result.error) {
  const file = `${sessionFile}.process-exit-${executionId}`;
  writeFileSync(`${file}.tmp`, String(result.status), "utf8");
  renameSync(`${file}.tmp`, file);
}
process.exitCode = result.status ?? 1;
