import assert from "node:assert/strict";
import test from "node:test";
import { SplitLine } from "../src/components/split-line.ts";

// 极窄视口曾让 String.repeat() 收到负数，RangeError 直接把 pi 崩掉
test("极窄宽度不抛异常", () => {
  for (const width of [-2, -1, 0, 1, 2, 3]) {
    assert.doesNotThrow(() => new SplitLine("left", "right", { padding: 1, innerPadding: 1, spacingChar: "─" }).render(width));
  }
});

test("正常宽度左右分列", () => {
  assert.equal(new SplitLine("L", "R", { spacingChar: "-" }).render(10)[0], "L--------R");
});
