import { fuzzyFilter } from "@earendil-works/pi-tui";

/** 选择器和运行时解析共用的最小模型标识。 */
export interface DistillSelectableModel {
  provider: string;
  id: string;
  name?: string;
}

/** `/config:distill` 模型列表中的一项。空 value 表示使用当前会话模型。 */
export interface DistillModelChoice {
  label: string;
  value: string;
  description?: string;
}

/** 把注册表模型拼成配置保存的 `provider/modelId`。模型 ID 本身可以包含 `/`。 */
export function distillModelReference(model: Pick<DistillSelectableModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/**
 * 构造模型选择列表。
 * 第一项固定为当前会话模型；其余按 provider、model ID 排序，并去掉重复引用。
 */
export function buildDistillModelChoices(
  models: readonly DistillSelectableModel[],
  currentLabel: string,
): DistillModelChoice[] {
  const choices: DistillModelChoice[] = [{ label: currentLabel, value: "" }];
  const seen = new Set<string>();
  const sorted = [...models].sort((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider);
    return providerOrder === 0 ? left.id.localeCompare(right.id) : providerOrder;
  });

  for (const model of sorted) {
    if (!model.provider || !model.id) continue;
    const value = distillModelReference(model);
    if (seen.has(value)) continue;
    seen.add(value);
    const name = model.name?.trim();
    choices.push({
      label: value,
      value,
      description: name && name !== model.id ? name : undefined,
    });
  }
  return choices;
}

/** 按 provider、model ID 和显示名过滤。空查询返回原列表。 */
export function filterDistillModelChoices(
  choices: readonly DistillModelChoice[],
  query: string,
): DistillModelChoice[] {
  const trimmed = query.trim();
  if (!trimmed) return [...choices];
  return fuzzyFilter([...choices], trimmed, (choice) => (
    `${choice.label} ${choice.value} ${choice.description ?? ""}`
  ));
}

/**
 * 在可用模型中解析一段模型引用。
 *
 * 先匹配完整的 `provider/modelId`，这样 OpenRouter 这类 ID 中带 `/` 的模型不会被第一段斜杠拆错。
 * 只有唯一匹配时，才接受把整段引用当作 model ID，例如 `deepseek/deepseek-v4-flash`。
 * 有多个候选时返回 undefined，避免静默选错 provider。
 */
export function resolveConfiguredDistillModel<T extends DistillSelectableModel>(
  reference: string,
  models: readonly T[],
): T | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  const canonical = models.filter((model) => distillModelReference(model).toLowerCase() === normalized);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;

  const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 解析这次提炼实际使用的模型。
 * 配置了模型时不回退到会话模型；找不到就返回 undefined，由调用方报告具体引用。
 */
export function resolveDistillRuntimeModel<T extends DistillSelectableModel>(
  configuredReference: string,
  registry: {
    find?: (provider: string, modelId: string) => T | undefined;
    getAvailable?: () => readonly T[];
  },
  sessionModel: T | undefined,
): T | undefined {
  const reference = configuredReference.trim();
  if (!reference) return sessionModel;

  const slash = reference.indexOf("/");
  if (slash > 0 && slash < reference.length - 1 && registry.find) {
    const found = registry.find(reference.slice(0, slash), reference.slice(slash + 1));
    if (found) return found;
  }
  return resolveConfiguredDistillModel(reference, registry.getAvailable?.() ?? []);
}
