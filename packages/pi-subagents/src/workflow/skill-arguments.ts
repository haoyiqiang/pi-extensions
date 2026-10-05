import { i18n } from "../i18n.js";
import { MAX_PREPARED_PROMPT_BYTES } from "./prompt-preparation.js";

/** Pi 0.87.1 quoting: no backslash escapes, empty tokens omitted, unclosed quotes tolerated. */
function tokenize(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

/** Deliberately one pass, not rpiv-args' legacy sequential expansion or shell hooks. */
export function expandWorkflowSkillArguments(body: string, input: string, baseDir: string): string {
  const args = tokenize(input);
  const all = args.join(" ");
  let bytes = 0;
  let cursor = 0;
  const account = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_PREPARED_PROMPT_BYTES) throw new Error(i18n.t("workflowResources.invalidPreparation"));
  };
  // Unknown named variables (including $ARGUMENTS_SUFFIX) remain literal.
  const result = body.replace(
    /\$\{(SKILL_DIR)\}|\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS(?!\w)|@|\d+)|\$\{[^}]*\}?|\$[A-Za-z_]\w*/g,
    (match: string, skillDir: string | undefined, target: string | undefined, fallback: string | undefined,
      start: string | undefined, length: string | undefined, simple: string | undefined, offset: number) => {
      let replacement: string;
      if (skillDir) replacement = baseDir;
      else if (target) {
        const value = target === "@" || target === "ARGUMENTS" ? all : args[Number(target) - 1];
        replacement = value || fallback || "";
      } else if (start) {
        const index = Math.max(0, Number(start) - 1);
        replacement = args.slice(index, length === undefined ? undefined : index + Number(length)).join(" ");
      } else if (simple === "ARGUMENTS" || simple === "@") replacement = all;
      else replacement = simple === undefined ? match : args[Number(simple) - 1] ?? "";
      account(body.slice(cursor, offset));
      account(replacement);
      cursor = offset + match.length;
      return replacement;
    },
  );
  account(body.slice(cursor));
  return result;
}
