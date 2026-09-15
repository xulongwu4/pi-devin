import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { loadCachedCatalog, loadCatalog } from "../src/catalog.js";
import { modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";
import {
  DEFAULT_API_SERVER,
  buildLoginUrl,
  exchangePkceCode,
  pkcePair,
  startCallbackServer,
} from "../src/login.js";

const PROVIDER_ID = "devin";
const API_IDENTIFIER = "devin-local" as const;
const DEFAULT_BASE_URL = "https://server.codeium.com";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function materializeModels(models: ProviderModelConfig[]): Model<typeof API_IDENTIFIER>[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: API_IDENTIFIER,
    provider: PROVIDER_ID,
    baseUrl: DEFAULT_BASE_URL,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

function createDevinProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: "Devin Local",
    baseUrl: DEFAULT_BASE_URL,
    auth: {
      apiKey: {
        name: "Devin API key",
        async login(interaction) {
          interaction.signal.throwIfAborted();
          const method = await interaction.prompt({
            type: "select",
            message: "How would you like to log in to Devin?",
            options: [
              { id: "browser", label: "Log in with browser", description: "Opens app.devin.ai and signs in with PKCE (recommended)" },
              { id: "key", label: "Paste an API key", description: "For SSH/remote sessions, or copying a key from credentials.toml" },
            ],
          });
          if (method === "key") {
            const key = (await interaction.prompt({ type: "secret", message: "Enter Devin API key" })).trim();
            if (!key) throw new Error("Devin: no API key entered");
            return { type: "api_key", key };
          }

          const { verifier, challenge } = pkcePair();
          const state = randomBytes(16).toString("base64url");
          const pending = startCallbackServer(state, interaction.signal);
          try {
            const redirectUri = await pending.redirectUri;
            interaction.notify({
              type: "auth_url",
              url: buildLoginUrl(redirectUri, challenge, state),
              instructions: "Sign in to Devin in your browser; it redirects back to this machine.",
            });
            const code = await pending.code;
            interaction.notify({ type: "progress", message: "Exchanging authorization code..." });
            const { apiKey } = await exchangePkceCode(code, verifier, redirectUri, DEFAULT_API_SERVER, interaction.signal);
            return { type: "api_key", key: apiKey };
          } finally {
            pending.close();
          }
        },
        async resolve({ credential }) {
          return credential?.key ? { auth: { apiKey: credential.key }, source: "stored API key" } : undefined;
        },
      },
    },
    models: materializeModels(modelsFromCatalog(loadCachedCatalog())),
    async fetchModels(context) {
      const credential = context.credential;
      if (credential?.type !== "api_key" || !credential.key) return [];
      const catalog = await loadCatalog({
        apiKey: credential.key,
        apiServerUrl: DEFAULT_BASE_URL,
        signal: context.signal,
      });
      return materializeModels(modelsFromCatalog(catalog));
    },
    api: {
      stream: streamDevin,
      streamSimple: streamDevin,
    },
  });
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createDevinProvider());

  pi.on("session_start", async (_event, ctx) => {
    await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin auth and endpoint status",
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      const baseUrl = ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ?? DEFAULT_BASE_URL;
      ctx.ui.notify(
        [
          apiKey ? "Auth: stored in Pi auth.json" : "Auth: not configured. Run /login devin",
          `Endpoint: ${baseUrl}`,
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
        ].join("\n"),
        apiKey ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Reload the Devin Local model catalog",
    handler: async (_args, ctx) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) {
        ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
        return;
      }
      const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
      const error = result.errors.get(PROVIDER_ID);
      if (error) {
        ctx.ui.notify(`Devin refresh failed: ${error.message}`, "error");
        return;
      }
      const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
      ctx.ui.notify(`Devin: loaded ${count} families.`, "info");
    },
  });
}
