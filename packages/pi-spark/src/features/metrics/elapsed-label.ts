interface ElapsedLabelListener {
  token: object;
  callback: () => void;
}

interface ElapsedLabelState {
  label?: string;
  listener?: ElapsedLabelListener;
}

/** Elapsed labels are owned by Pi's stable per-session sessionManager object. */
export type ElapsedLabelOwner = object;

const states = new WeakMap<ElapsedLabelOwner, ElapsedLabelState>();

function stateFor(owner: ElapsedLabelOwner): ElapsedLabelState {
  let state = states.get(owner);
  if (state === undefined) {
    state = {};
    states.set(owner, state);
  }
  return state;
}

/** Current elapsed label for one spark editor/session. Undefined hides it. */
export function getElapsedLabel(owner: ElapsedLabelOwner): string | undefined {
  return states.get(owner)?.label;
}

/** Updates one session's editor elapsed label and asks only that editor to redraw. */
export function setElapsedLabel(owner: ElapsedLabelOwner, value: string | undefined): void {
  const state = stateFor(owner);
  if (state.label === value) return;
  state.label = value;
  state.listener?.callback();
}

/**
 * Registers one session's editor redraw hook.
 *
 * Cleanup is token-owned: an older runtime disposing after a replacement cannot detach the
 * replacement listener for the same session.
 */
export function setElapsedLabelListener(
  owner: ElapsedLabelOwner,
  callback: () => void,
): () => void {
  const state = stateFor(owner);
  const listener: ElapsedLabelListener = { token: {}, callback };
  state.listener = listener;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = states.get(owner);
    if (current?.listener?.token === listener.token) current.listener = undefined;
  };
}
