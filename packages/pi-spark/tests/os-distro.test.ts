import assert from "node:assert/strict";
import test from "node:test";

import { parseDistroIds } from "../src/utils/os.ts";

test("os-release keeps ID before ID_LIKE", () => {
  assert.deepEqual(parseDistroIds('NAME="Arch Linux"\nID=arch\n'), ["arch"]);
  assert.deepEqual(parseDistroIds('ID=cachyos\nID_LIKE="arch"\n'), ["cachyos", "arch"]);
  assert.deepEqual(parseDistroIds('ID=ubuntu\nID_LIKE=debian ubuntu\n'), ["ubuntu", "debian", "ubuntu"]);
});

test("os-release without identifiers yields none", () => {
  assert.deepEqual(parseDistroIds(""), []);
  assert.deepEqual(parseDistroIds("PRETTY_NAME=\"Unknown\"\n"), []);
});
