let label: string | undefined;
let listener: (() => void) | undefined;

/** Current elapsed label for the spark editor border. Undefined hides it. */
export function getElapsedLabel(): string | undefined {
  return label;
}

/** Updates the editor elapsed label and asks the active editor to redraw. */
export function setElapsedLabel(value: string | undefined): void {
  if (label === value) return;
  label = value;
  listener?.();
}

/** Registers the editor redraw hook. Passing undefined detaches it. */
export function setElapsedLabelListener(next: (() => void) | undefined): void {
  listener = next;
}
