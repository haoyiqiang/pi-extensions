import assert from "node:assert/strict";
import test from "node:test";
import { registerEditor } from "../src/features/editor/index.ts";
import {
  getElapsedLabel,
  setElapsedLabel,
  setElapsedLabelListener,
} from "../src/features/metrics/elapsed-label.ts";

test("elapsed labels and redraw hooks are isolated by session owner", () => {
  const parent = {};
  const child = {};
  let parentRenders = 0;
  let childRenders = 0;
  const releaseParent = setElapsedLabelListener(parent, () => { parentRenders += 1; });
  const releaseChild = setElapsedLabelListener(child, () => { childRenders += 1; });

  setElapsedLabel(parent, "parent");
  assert.equal(getElapsedLabel(parent), "parent");
  assert.equal(getElapsedLabel(child), undefined);
  assert.equal(parentRenders, 1);
  assert.equal(childRenders, 0);

  setElapsedLabel(child, "child");
  assert.equal(getElapsedLabel(parent), "parent");
  assert.equal(getElapsedLabel(child), "child");
  assert.equal(parentRenders, 1);
  assert.equal(childRenders, 1);

  releaseParent();
  releaseChild();
});

test("listener cleanup is token-owned and cannot detach a replacement", () => {
  const owner = {};
  let oldRenders = 0;
  let replacementRenders = 0;
  const releaseOld = setElapsedLabelListener(owner, () => { oldRenders += 1; });
  const releaseReplacement = setElapsedLabelListener(owner, () => { replacementRenders += 1; });

  releaseOld();
  setElapsedLabel(owner, "replacement");
  assert.equal(oldRenders, 0);
  assert.equal(replacementRenders, 1);

  releaseReplacement();
});

test("registering a filtered spark factory does not steal the root redraw hook", () => {
  const rootOwner = {};
  let rootRenders = 0;
  const releaseRoot = setElapsedLabelListener(rootOwner, () => { rootRenders += 1; });
  const handlers = new Map<string, unknown>();

  registerEditor({
    on(name: string, handler: unknown) {
      handlers.set(name, handler);
    },
  } as any, { on() {} } as any);

  assert.ok(handlers.has("session_start"));
  setElapsedLabel(rootOwner, "still-root-owned");
  assert.equal(rootRenders, 1);
  releaseRoot();
});
