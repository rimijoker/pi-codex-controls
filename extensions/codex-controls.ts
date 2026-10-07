import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type CodexModel = NonNullable<ExtensionContext["model"]>;
type Payload = Record<string, unknown>;

type SessionState = {
	fastMode: boolean;
	largeContext: boolean;
	originalModel?: CodexModel;
	applyingModel: boolean;
};

export const CODEX_RESPONSES_API = "openai-codex-responses";
export const LARGE_CONTEXT_WINDOW = 1_050_000;

export function isCodexResponsesModel(model: CodexModel | undefined): model is CodexModel {
	return model?.api === CODEX_RESPONSES_API;
}

export function addPriorityTier(payload: unknown): Payload | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	return { ...(payload as Payload), service_tier: "priority" };
}

function modelKey(model: CodexModel): string {
	return `${model.provider}/${model.id}`;
}

function loadExpandedModels(filePath: string): Set<string> {
	try {
		const data = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (typeof data !== "object" || data === null || Array.isArray(data)) return new Set();
		const expandedModels = (data as { expandedModels?: unknown }).expandedModels;
		return new Set(Array.isArray(expandedModels) ? expandedModels.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function saveExpandedModels(filePath: string, expandedModels: Set<string>): boolean {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify({ expandedModels: [...expandedModels] }, null, 2)}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

function getState(states: WeakMap<object, SessionState>, ctx: ExtensionContext): SessionState {
	const key = ctx.sessionManager as object;
	let state = states.get(key);
	if (!state) {
		state = { fastMode: false, largeContext: false, applyingModel: false };
		const model = ctx.model;
		if (isCodexResponsesModel(model)) {
			const originalModel = ctx.modelRegistry.find(model.provider, model.id);
			if (
				originalModel &&
				originalModel.contextWindow < LARGE_CONTEXT_WINDOW &&
				model.contextWindow >= LARGE_CONTEXT_WINDOW
			) {
				state.largeContext = true;
				state.originalModel = originalModel;
			}
		}
		states.set(key, state);
	}
	return state;
}

function updateStatus(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;
	const compatible = isCodexResponsesModel(ctx.model);
	ctx.ui.setStatus("codex-controls-fast", compatible && state.fastMode ? "Fast requested" : undefined);
	ctx.ui.setStatus("codex-controls-context", compatible && state.largeContext ? "Context 1.05M*" : undefined);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function applySavedContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: SessionState,
	expandedModels: Set<string>,
): Promise<void> {
	const model = ctx.model;
	if (!isCodexResponsesModel(model) || state.largeContext || !expandedModels.has(modelKey(model))) return;

	const catalogModel = ctx.modelRegistry.find(model.provider, model.id);
	if (model.contextWindow >= LARGE_CONTEXT_WINDOW) {
		state.largeContext = true;
		state.originalModel = catalogModel && catalogModel.contextWindow < LARGE_CONTEXT_WINDOW ? catalogModel : undefined;
		return;
	}

	state.applyingModel = true;
	try {
		const applied = await pi.setModel({ ...model, contextWindow: LARGE_CONTEXT_WINDOW });
		if (!applied) {
			notify(ctx, "Pi couldn't restore the saved context preference.", "warning");
			return;
		}
		state.originalModel = catalogModel ?? model;
		state.largeContext = true;
	} catch (error) {
		notify(ctx, `Couldn't restore the saved context preference: ${error instanceof Error ? error.message : String(error)}`, "warning");
	} finally {
		state.applyingModel = false;
	}
}

export default function codexControls(pi: ExtensionAPI): void {
	const states = new WeakMap<object, SessionState>();
	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const preferencesPath = join(configDir, "codex-controls.json");
	const expandedModels = loadExpandedModels(preferencesPath);

	pi.on("session_start", async (_event, ctx) => {
		const state = getState(states, ctx);
		await applySavedContext(pi, ctx, state, expandedModels);
		updateStatus(ctx, state);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(ctx.sessionManager as object);
	});

	pi.on("model_select", async (_event, ctx) => {
		const state = getState(states, ctx);
		if (state.applyingModel) {
			updateStatus(ctx, state);
			return;
		}
		if (state.largeContext) {
			state.largeContext = false;
			state.originalModel = undefined;
			notify(ctx, "The context override was reset after changing models.");
		}
		await applySavedContext(pi, ctx, state, expandedModels);
		updateStatus(ctx, state);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexResponsesModel(ctx.model)) return;
		const state = getState(states, ctx);
		return state.fastMode ? addPriorityTier(event.payload) : undefined;
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle Fast mode for OpenAI Codex Responses models",
		handler: async (_args, ctx) => {
			if (!isCodexResponsesModel(ctx.model)) {
				notify(ctx, "Select an OpenAI Codex Responses model first.", "warning");
				return;
			}
			const state = getState(states, ctx);
			state.fastMode = !state.fastMode;
			updateStatus(ctx, state);
			notify(ctx, `Codex Fast mode ${state.fastMode ? "requested" : "disabled"}.`);
		},
	});

	pi.registerCommand("codex-context", {
		description: "Toggle Pi's 1.05M-token context budget for OpenAI Codex Responses models",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!isCodexResponsesModel(model)) {
				notify(ctx, "Select an OpenAI Codex Responses model first.", "warning");
				return;
			}

			const state = getState(states, ctx);
			state.applyingModel = true;
			try {
				if (state.largeContext) {
					if (!state.originalModel) {
						notify(ctx, "Can't restore the original model context setting.", "error");
						return;
					}
					const restored = await pi.setModel(state.originalModel);
					if (!restored) {
						notify(ctx, "Pi couldn't restore the original model settings.", "error");
						return;
					}
					state.largeContext = false;
					state.originalModel = undefined;
					expandedModels.delete(modelKey(model));
					const saved = saveExpandedModels(preferencesPath, expandedModels);
					notify(
						ctx,
						saved
							? "Restored the model's catalog context budget and saved the preference."
							: "Restored the catalog budget for this session, but couldn't save the preference. It may return next session.",
						saved ? "info" : "warning",
					);
				} else {
					const expandedModel = { ...model, contextWindow: LARGE_CONTEXT_WINDOW };
					const applied = await pi.setModel(expandedModel);
					if (!applied) {
						notify(ctx, "Pi couldn't apply the larger local context budget.", "error");
						return;
					}
					state.originalModel = model;
					state.largeContext = true;
					expandedModels.add(modelKey(model));
					const saved = saveExpandedModels(preferencesPath, expandedModels);
					notify(
						ctx,
						`Pi will keep up to 1.05M tokens locally. This does not raise the endpoint's server limit; requests over that limit can fail.${saved ? " Saved for this model across sessions." : " Couldn't save the preference; it will reset next session."}`,
						"warning",
					);
				}
			} catch (error) {
				notify(ctx, `Context toggle failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				state.applyingModel = false;
				updateStatus(ctx, state);
			}
		},
	});
}
