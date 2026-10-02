import assert from "node:assert/strict";
import test from "node:test";

import { formatP10kLeft, osPromptIcon } from "../src/features/footer/p10k.ts";

import type { P10kPaint } from "../src/features/footer/p10k.ts";

const plain: P10kPaint = {
  text: (value) => value,
  dim: (value) => value,
  accent: (value) => value,
  success: (value) => value,
};

test("p10k left prompt keeps a fish path and omits ahead/behind counts", () => {
  const text = formatP10kLeft(
    {
      osIcon: osPromptIcon("darwin"),
      path: "/V/E/o/pi-extensions",
      branch: "main",
    },
    plain,
  );

  assert.equal(text, "\uF179 \uE0B1 \uF115 /V/E/o/pi-extensions \uE0B1 on \uF113 \uF126 main");
});

test("p10k left prompt omits git when there is no branch", () => {
  const text = formatP10kLeft({ path: "~/src", branch: null }, plain);
  assert.equal(text, "\uF115 ~/src");
});
