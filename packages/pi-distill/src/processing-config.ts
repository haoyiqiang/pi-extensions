import { createTranslator, loadCatalog } from "pi-utils";

export const processingI18n = createTranslator(loadCatalog(new URL("./processing-catalog.json", import.meta.url)));

export interface EvidenceConfig {
  enabled: boolean;
  fusion: boolean;
  minBytes: number;
  /** Additional literal diagnostic command prefixes; not regular expressions. */
  commands: string[];
}
export interface ArchiveConfig {
  maxSourceBytes: number;
  maxSessionBytes: number;
}
export interface ProcessingConfig {
  evidence?: Partial<EvidenceConfig>;
  archive?: Partial<ArchiveConfig>;
}

export function processingConfig(config: ProcessingConfig = {}): { evidence: EvidenceConfig; archive: ArchiveConfig } {
  return {
    evidence: { enabled: false, fusion: false, minBytes: 8192, commands: [], ...config.evidence },
    archive: { maxSourceBytes: 1024 * 1024, maxSessionBytes: 64 * 1024 * 1024, ...config.archive },
  };
}

export function parseProcessingConfig(file: Record<string, unknown> | undefined): ProcessingConfig {
  const result: ProcessingConfig = {};
  const fail = (field: string, reason: string): never => {
    throw new Error(processingI18n.t("invalidConfig", { field, reason: processingI18n.t(reason) }));
  };
  for (const section of ["evidence", "archive"] as const) {
    if (!file || !(section in file)) continue;
    const source = file[section];
    const allowed = section === "evidence" ? ["enabled", "fusion", "minBytes", "commands"] : ["maxSourceBytes", "maxSessionBytes"];
    if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some((key) => !allowed.includes(key))) {
      fail(section, "configObject");
    }
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (key === "enabled" || key === "fusion") {
        if (typeof value !== "boolean") fail(`${section}.${key}`, "configBoolean");
      } else if (key === "commands") {
        if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 256 || /[\r\n\0]/.test(item))) {
          fail(`${section}.${key}`, "configCommands");
        }
      } else {
        const maximum = key === "maxSessionBytes" ? 1024 * 1024 * 1024 : 16 * 1024 * 1024;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(`${section}.${key}`, "configBytes");
      }
      parsed[key] = value;
    }
    if (section === "evidence") result.evidence = parsed;
    else result.archive = parsed;
  }
  return result;
}

/** Fusion processing never implicitly enables ordinary mutations or overrides an explicit tool opt-out. */
export function fusionEvidenceEnabled(config: ProcessingConfig & { tools?: Record<string, { enabled: boolean }> }, toolName: string): boolean {
  const { evidence } = processingConfig(config);
  return (toolName === "edit" || toolName === "write") && evidence.enabled && evidence.fusion && config.tools?.[toolName]?.enabled !== false;
}

export function isMutationTool(toolName: string): boolean {
  return toolName === "edit" || toolName === "write";
}

/** Any enabled mutation tool is evidence-only; never summarize file confirmations or patches. */
export function processingEnabled(config: ProcessingConfig & { tools?: Record<string, { enabled: boolean }> }, toolName: string): boolean {
  if (isMutationTool(toolName)) return fusionEvidenceEnabled(config, toolName);
  return config.tools?.[toolName]?.enabled !== false;
}

export function sourceReference(artifact: { path: string; sha256: string; bytes: number; lines: number; kind: string }): string {
  return [
    `source_artifact=${JSON.stringify(artifact.path)}`,
    `source_sha256=${artifact.sha256}`,
    `source_bytes=${artifact.bytes}`,
    `source_lines=${artifact.lines}`,
    `source_kind=${artifact.kind}`,
    processingI18n.t("readback"),
  ].join("\n");
}

export function processingReceipt(mode: "summary" | "evidence", text: string, source: Parameters<typeof sourceReference>[0], isError: boolean): string {
  return [
    `[distill:${mode}]`,
    `tool_status=${isError ? "error" : "success"}`,
    processingI18n.t(mode === "evidence" ? "evidenceNotice" : "summaryNotice"),
    text,
    sourceReference(source),
  ].join("\n\n");
}
