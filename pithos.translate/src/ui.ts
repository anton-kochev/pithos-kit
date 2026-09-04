import { BorderedLoader, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseLanguage,
  type InputTranslateConfig,
  type OutputTranslateConfig,
} from "./config.ts";
import { TARGET_LANGUAGE_PLACEHOLDER, TargetLanguageInput } from "./language-input.ts";
import type { TranslationResult } from "./translation.ts";

export async function runTranslationWithUi(
  ctx: ExtensionCommandContext,
  language: string,
  model: string,
  task: (signal?: AbortSignal) => Promise<TranslationResult>,
): Promise<TranslationResult> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return {
      ok: false,
      kind: "unsupported-mode",
      error: "Translation display is available only in Pi's interactive TUI.",
    };
  }

  const result = await ctx.ui.custom<TranslationResult | undefined>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Translating into ${language} with ${model}…`, { cancellable: true });
    let finished = false;
    const finish = (value: TranslationResult | undefined): void => {
      if (finished) return;
      finished = true;
      done(value);
    };
    loader.onAbort = () => finish(undefined);
    task(loader.signal)
      .then(finish)
      .catch((error: unknown) => finish({
        ok: false,
        kind: "request-failed",
        error: error instanceof Error ? error.message : "Translation model request failed.",
      }));
    return loader;
  });

  return result ?? { ok: false, kind: "cancelled", error: "Translation cancelled." };
}

export async function runConfigWizard(
  ctx: ExtensionContext,
  current?: OutputTranslateConfig,
): Promise<OutputTranslateConfig | undefined> {
  if (!ctx.hasUI) return undefined;

  let language: string | undefined;
  while (!language) {
    const answer = typeof ctx.ui.custom === "function"
      ? await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
          new TargetLanguageInput(tui, theme, current?.language, done))
      : await ctx.ui.input("Target language", TARGET_LANGUAGE_PLACEHOLDER);
    if (answer === undefined) return undefined;
    language = parseLanguage(answer);
    if (!language) {
      ctx.ui.notify(
        /[\r\n]/u.test(answer) ? "Target language must be a single line." : "Target language is required.",
        "warning",
      );
    }
  }

  const model = await chooseAuthenticatedModel(ctx, "Exact output translation model");
  if (!model) return undefined;
  return {
    language,
    model,
    mode: current?.mode ?? "off",
    ...(current?.timeoutMs !== undefined ? { timeoutMs: current.timeoutMs } : {}),
  };
}

export async function runInputConfigWizard(
  ctx: ExtensionContext,
  current?: InputTranslateConfig,
): Promise<InputTranslateConfig | undefined> {
  if (!ctx.hasUI) return undefined;
  const model = await chooseAuthenticatedModel(ctx, "Exact input translation model");
  if (!model) return undefined;
  return {
    model,
    mode: current?.mode ?? "off",
    ...(current?.timeoutMs !== undefined ? { timeoutMs: current.timeoutMs } : {}),
  };
}

async function chooseAuthenticatedModel(ctx: ExtensionContext, title: string): Promise<string | undefined> {
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
  if (models.length === 0) {
    ctx.ui.notify("No authenticated translation models are available. Configure a provider with /login first.", "error");
    return undefined;
  }

  const choices = models.map((model) => `${model.provider}/${model.id} — ${model.name}`);
  const selected = await ctx.ui.select(title, choices);
  if (!selected) return undefined;
  const model = models[choices.indexOf(selected)];
  return model ? `${model.provider}/${model.id}` : undefined;
}
