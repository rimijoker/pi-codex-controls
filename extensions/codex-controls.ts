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

export default function codexControls(pi: ExtensionAPI): void {
	const states = new WeakMap<object, SessionState>();

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx, getState(states, ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		states.delete(ctx.sessionManager as object);
	});

	pi.on("model_select", (_event, ctx) => {
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
					notify(ctx, "Restored the model's catalog context budget.");
				} else {
					const expandedModel = { ...model, contextWindow: LARGE_CONTEXT_WINDOW };
					const applied = await pi.setModel(expandedModel);
					if (!applied) {
						notify(ctx, "Pi couldn't apply the larger local context budget.", "error");
						return;
					}
					state.originalModel = model;
					state.largeContext = true;
					notify(
						ctx,
						"Pi will keep up to 1.05M tokens locally. This does not raise the endpoint's server limit; requests over that limit can fail.",
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
