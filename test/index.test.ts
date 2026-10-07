import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexControls, { addPriorityTier, isCodexResponsesModel, LARGE_CONTEXT_WINDOW } from "../extensions/codex-controls.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void };

const codexModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	contextWindow: 272_000,
	maxTokens: 128_000,
};

const preferenceDirs = new Set<string>();
afterAll(() => {
	for (const dir of preferenceDirs) rmSync(dir, { recursive: true, force: true });
});

function createHarness(
	options: { failSetModel?: boolean; initialModel?: typeof codexModel; preferenceDir?: string } = {},
) {
	let model: typeof codexModel = options.initialModel ?? codexModel;
	const sessionManager = {};
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const statuses = new Map<string, string | undefined>();
	const notices: Array<{ message: string; type: string }> = [];
	const ctx = {
		sessionManager,
		hasUI: true,
		get model() {
			return model;
		},
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			notify: (message: string, type: string) => notices.push({ message, type }),
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === codexModel.provider && id === codexModel.id ? codexModel : undefined,
		},
	} as unknown as ExtensionCommandContext;

	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		async setModel(nextModel: typeof codexModel) {
			if (options.failSetModel) return false;
			model = nextModel;
			await emit("model_select");
			return true;
		},
	} as unknown as ExtensionAPI;

	async function emit(event: string, payload: unknown = {}) {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			result = (await handler(payload, ctx as unknown as ExtensionContext)) ?? result;
		}
		return result;
	}

	const preferenceDir = options.preferenceDir ?? mkdtempSync(join(tmpdir(), "pi-codex-controls-test-"));
	preferenceDirs.add(preferenceDir);
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = preferenceDir;
	try {
		codexControls(api);
	} finally {
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
	}

	return {
		ctx,
		commands,
		notices,
		statuses,
		emit,
		get model() {
			return model;
		},
		setModel: async (nextModel: typeof codexModel) => {
			model = nextModel;
			await emit("model_select");
		},
	};
}

describe("Codex model detection and Fast request mutation", () => {
	it("recognizes Codex Responses models, including compatible provider IDs", () => {
		expect(isCodexResponsesModel(codexModel as never)).toBe(true);
		expect(isCodexResponsesModel({ ...codexModel, provider: "custom-codex-proxy" } as never)).toBe(true);
		expect(isCodexResponsesModel({ ...codexModel, api: "openai-completions" } as never)).toBe(false);
		expect(isCodexResponsesModel(undefined)).toBe(false);
	});

	it("adds priority to a copied object payload and ignores invalid payloads", () => {
		const payload = { model: "gpt-6-luna", input: "hello" };
		const updated = addPriorityTier(payload);

		expect(updated).toEqual({ ...payload, service_tier: "priority" });
		expect(updated).not.toBe(payload);
		expect(payload).not.toHaveProperty("service_tier");
		expect(addPriorityTier(null)).toBeUndefined();
		expect(addPriorityTier(["not", "an object"])).toBeUndefined();
	});

	it("toggles Fast mode on and off for Codex requests only", async () => {
		const h = createHarness();
		await h.emit("session_start");
		await h.commands.get("codex-fast")!.handler("", h.ctx);

		const payload = { input: "hello" };
		expect(await h.emit("before_provider_request", { payload })).toEqual({
			...payload,
			service_tier: "priority",
		});
		expect(h.statuses.get("codex-controls-fast")).toBe("Fast requested");

		await h.commands.get("codex-fast")!.handler("", h.ctx);
		expect(await h.emit("before_provider_request", { payload })).toBeUndefined();
		expect(h.statuses.get("codex-controls-fast")).toBeUndefined();
	});

	it("applies Fast mode to any provider using the Codex Responses API", async () => {
		const h = createHarness();
		await h.setModel({ ...codexModel, provider: "custom-codex-proxy", id: "gpt-6-luna" });
		await h.emit("session_start");
		await h.commands.get("codex-fast")!.handler("", h.ctx);

		expect(await h.emit("before_provider_request", { payload: { input: "hello" } })).toEqual({
			input: "hello",
			service_tier: "priority",
		});
	});

	it("keeps Fast mode scoped to its session", async () => {
		const first = createHarness();
		const second = createHarness();
		await first.emit("session_start");
		await second.emit("session_start");
		await first.commands.get("codex-fast")!.handler("", first.ctx);

		expect(await first.emit("before_provider_request", { payload: { input: "hello" } })).toHaveProperty(
			"service_tier",
			"priority",
		);
		expect(await second.emit("before_provider_request", { payload: { input: "hello" } })).toBeUndefined();
	});

	it("leaves non-Codex requests unchanged even when Fast is enabled", async () => {
		const h = createHarness();
		await h.emit("session_start");
		await h.commands.get("codex-fast")!.handler("", h.ctx);
		await h.setModel({ ...codexModel, api: "openai-completions" });

		expect(await h.emit("before_provider_request", { payload: { input: "hello" } })).toBeUndefined();
		expect(h.notices.some((notice) => notice.message.includes("reset"))).toBe(false);
	});
});

describe("local context-window toggle", () => {
	it("sets Pi's local budget to 1.05M and restores the original model", async () => {
		const h = createHarness();
		const original = h.model;
		await h.emit("session_start");
		await h.commands.get("codex-context")!.handler("", h.ctx);

		expect(h.model).not.toBe(original);
		expect(h.model.id).toBe(original.id);
		expect(h.model.provider).toBe(original.provider);
		expect(h.model.contextWindow).toBe(LARGE_CONTEXT_WINDOW);
		expect(h.statuses.get("codex-controls-context")).toBe("Context 1.05M*");
		expect(h.notices.at(-1)?.type).toBe("warning");
		expect(h.notices.at(-1)?.message).toContain("does not raise the endpoint's server limit");

		await h.commands.get("codex-context")!.handler("", h.ctx);
		expect(h.model).toBe(original);
		expect(h.statuses.get("codex-controls-context")).toBeUndefined();
	});

	it("recognizes an override that was active before extension reload", async () => {
		const expandedModel = { ...codexModel, contextWindow: LARGE_CONTEXT_WINDOW };
		const h = createHarness({ initialModel: expandedModel });
		await h.emit("session_start");

		expect(h.statuses.get("codex-controls-context")).toBe("Context 1.05M*");
		await h.commands.get("codex-context")!.handler("", h.ctx);
		expect(h.model).toBe(codexModel);
	});

	it("persists context per model across sessions and clears the saved preference when disabled", async () => {
		const preferenceDir = mkdtempSync(join(tmpdir(), "pi-codex-controls-persistence-test-"));
		preferenceDirs.add(preferenceDir);
		const first = createHarness({ preferenceDir });
		await first.emit("session_start");
		await first.commands.get("codex-context")!.handler("", first.ctx);

		const otherModel = createHarness({ preferenceDir, initialModel: { ...codexModel, id: "gpt-6-sol" } });
		await otherModel.emit("session_start");
		expect(otherModel.model.contextWindow).toBe(272_000);

		const second = createHarness({ preferenceDir });
		await second.emit("session_start");
		expect(second.model.contextWindow).toBe(LARGE_CONTEXT_WINDOW);
		expect(second.statuses.get("codex-controls-context")).toBe("Context 1.05M*");
		await second.commands.get("codex-context")!.handler("", second.ctx);

		const third = createHarness({ preferenceDir });
		await third.emit("session_start");
		expect(third.model.contextWindow).toBe(272_000);
	});

	it("restores a local override after extension state is reinitialized", async () => {
		const expandedModel = { ...codexModel, contextWindow: LARGE_CONTEXT_WINDOW };
		const h = createHarness({ initialModel: expandedModel });
		await h.commands.get("codex-context")!.handler("", h.ctx);

		expect(h.model).toBe(codexModel);
		expect(h.statuses.get("codex-controls-context")).toBeUndefined();
	});

	it("resets the override if the user selects another model", async () => {
		const h = createHarness();
		await h.emit("session_start");
		await h.commands.get("codex-context")!.handler("", h.ctx);
		await h.setModel({ ...codexModel, id: "gpt-6-sol", name: "GPT-6 Sol" });

		expect(h.statuses.get("codex-controls-context")).toBeUndefined();
		expect(h.notices.at(-1)?.message).toContain("reset after changing models");
	});

	it("does not claim to change context when Pi rejects the model update", async () => {
		const h = createHarness({ failSetModel: true });
		await h.emit("session_start");
		await h.commands.get("codex-context")!.handler("", h.ctx);

		expect(h.model.contextWindow).toBe(272_000);
		expect(h.statuses.get("codex-controls-context")).toBeUndefined();
		expect(h.notices.at(-1)?.type).toBe("error");
	});

	it("refuses commands on models that do not use the Codex Responses API", async () => {
		const h = createHarness();
		await h.setModel({ ...codexModel, api: "openai-completions" });
		await h.commands.get("codex-context")!.handler("", h.ctx);
		await h.commands.get("codex-fast")!.handler("", h.ctx);

		expect(h.model.contextWindow).toBe(272_000);
		expect(h.notices.filter((notice) => notice.type === "warning")).toHaveLength(2);
	});
});
