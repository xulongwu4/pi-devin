import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { createProvider, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
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
      oauth: {
        name: "Devin",
        isSubscription: true,
        async login(interaction) {
          interaction.signal.throwIfAborted();
          const { verifier, challenge } = pkcePair();
          const state = randomBytes(16).toString("base64url");
          const pending = startCallbackServer(state, interaction.signal);
          let key: string;
          try {
            const redirectUri = await pending.redirectUri;
            interaction.notify({
              type: "auth_url",
              url: buildLoginUrl(redirectUri, challenge, state),
              instructions: "Sign in to Devin in your browser; it redirects back to this machine.",
            });
            const code = await pending.code;
            interaction.notify({ type: "progress", message: "Exchanging authorization code..." });
            key = (await exchangePkceCode(code, verifier, redirectUri, DEFAULT_API_SERVER, interaction.signal)).apiKey;
          } finally {
            pending.close();
          }
          // The API key is long-lived; wrap it as an OAuth credential with a
          // soft one-year sentinel expiry (same as the original provider).
          return { type: "oauth", refresh: "", access: key, expires: Date.now() + ONE_YEAR_MS };
        },
        async refresh(credential) {
          return { ...credential, expires: Date.now() + ONE_YEAR_MS };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: materializeModels(modelsFromCatalog(loadCachedCatalog())),
    async fetchModels(context) {
      const credential = context.credential;
      if (credential?.type !== "oauth" || !credential.access) return [];
      const catalog = await loadCatalog({
        apiKey: credential.access,
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
