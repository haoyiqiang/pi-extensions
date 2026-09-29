import {
  type ExtensionCommandContext,
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  buildDistillModelChoices,
  filterDistillModelChoices,
  type DistillModelChoice,
  type DistillSelectableModel,
} from "./model-choice.ts";

/** 模型选择器上的本地化文案。 */
export interface DistillModelPickerLabels {
  title: string;
  currentModel: string;
  filterPlaceholder: string;
  noMatch: string;
  navigate: string;
  select: string;
  cancel: string;
  filter: string;
}

const MAX_VISIBLE_MODELS = 12;

/** 读取当前可用模型。与 `/model` 默认列表相同，不使用会话范围过滤。 */
export function listDistillSelectableModels(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): DistillSelectableModel[] {
  const available = ctx.modelRegistry.getAvailable?.() ?? [];
  return available.filter((model) => Boolean(model.provider) && Boolean(model.id));
}

function createModelList(
  choices: readonly DistillModelChoice[],
  selectedValue: string,
  onSelect: (value: string) => void,
  onCancel: () => void,
): SelectList {
  const list = new SelectList(
    choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description,
    })),
    Math.min(MAX_VISIBLE_MODELS, Math.max(choices.length, 1)),
    getSelectListTheme(),
    { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 72 },
  );
  const selectedIndex = choices.findIndex((choice) => choice.value === selectedValue);
  if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
  list.onSelect = (item) => onSelect(item.value);
  list.onCancel = onCancel;
  return list;
}

async function selectFromPlainList(
  ctx: ExtensionCommandContext,
  choices: readonly DistillModelChoice[],
  labels: DistillModelPickerLabels,
): Promise<string | undefined> {
  const selected = await ctx.ui.select(labels.title, choices.map((choice) => (
    choice.value === "" ? choice.label : choice.value
  )));
  if (selected === undefined) return undefined;
  if (selected === labels.currentModel) return "";
  return choices.find((choice) => choice.value === selected)?.value;
}

/**
 * 打开可搜索的模型选择器。
 * 返回空字符串表示改回当前会话模型；取消时返回 undefined。
 */
export async function selectDistillModel(
  ctx: ExtensionCommandContext,
  models: readonly DistillSelectableModel[],
  current: string,
  labels: DistillModelPickerLabels,
): Promise<string | undefined> {
  const choices = buildDistillModelChoices(models, labels.currentModel);
  if (ctx.mode !== "tui") {
    return selectFromPlainList(ctx, choices, labels);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input({ placeholder: labels.filterPlaceholder });
    input.focused = true;
    let list = createModelList(choices, current, (value) => done(value), () => done(undefined));

    const root = new Container();
    const listHost = new Container();
    root.addChild(new DynamicBorder());
    root.addChild(new Spacer(1));
    root.addChild(new Text(theme.fg("accent", theme.bold(labels.title)), 1, 0));
    root.addChild(new Spacer(1));
    root.addChild(input);
    root.addChild(new Spacer(1));
    root.addChild(listHost);
    root.addChild(new Spacer(1));
    root.addChild(new Text([
      rawKeyHint("↑↓", labels.navigate),
      keyHint("tui.select.confirm", labels.select),
      keyHint("tui.select.cancel", labels.cancel),
      rawKeyHint("type", labels.filter),
    ].join("  "), 1, 0));
    root.addChild(new Spacer(1));
    root.addChild(new DynamicBorder());

    const rebuild = (selectedValue: string): void => {
      const filtered = filterDistillModelChoices(choices, input.getValue());
      listHost.clear();
      if (filtered.length === 0) {
        listHost.addChild(new Text(theme.fg("warning", labels.noMatch), 1, 0));
        return;
      }
      list = createModelList(filtered, selectedValue, (value) => done(value), () => done(undefined));
      listHost.addChild(list);
    };
    rebuild(current);

    return {
      render: (width) => root.render(width),
      invalidate: () => root.invalidate(),
      handleInput: (data) => {
        const query = input.getValue();
        if (keybindings.matches(data, "tui.select.cancel")) {
          if (query && data === "\u001b") {
            input.setValue("");
            rebuild(current);
            tui.requestRender();
            return;
          }
          done(undefined);
          tui.requestRender();
          return;
        }
        if (
          keybindings.matches(data, "tui.select.up")
          || keybindings.matches(data, "tui.select.down")
          || keybindings.matches(data, "tui.select.confirm")
        ) {
          if (filterDistillModelChoices(choices, query).length === 0) return;
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        const selectedValue = list.getSelectedItem()?.value ?? current;
        input.handleInput(data);
        if (input.getValue() !== query) rebuild(selectedValue);
        tui.requestRender();
      },
    };
  });
}
