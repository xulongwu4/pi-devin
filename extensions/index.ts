import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createProvider, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import { loginWithCli } from "../src/credentials.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import { loadCatalog } from "../src/catalog.js";
import { FALLBACK_MODELS, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const API_IDENTIFIER = "devin-local" as const;
const DEFAULT_BASE_URL = "https://server.codeium.com";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let effectiveBaseUrl = DEFAULT_BASE_URL;

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

async function refreshDevinProvider(
  pi: ExtensionAPI,
  apiKey: string,
  baseUrl: string,
): Promise<number> {
  const catalog = await loadCatalog({ apiKey, apiServerUrl: baseUrl });
  const models = modelsFromCatalog(catalog);
  pi.registerProvider(createDevinProvider(pi, models));
  return models.length;
}

function createDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  return createProvider({
    id: PROVIDER_ID,
    name: "Devin Local",
    baseUrl: DEFAULT_BASE_URL,
    auth: {
      oauth: {
        name: "Devin CLI",
        isSubscription: true,
        async login(): Promise<OAuthCredential> {
          const credentials = await loginWithCli();
          try {
            await refreshDevinProvider(pi, credentials.apiKey, effectiveBaseUrl);
          } catch {
            // Login remains valid when catalog refresh and cache both fail.
          }
          return {
            type: "oauth",
            refresh: "",
            access: credentials.apiKey,
            expires: Date.now() + ONE_YEAR_MS,
          };
        },
        async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
          return { ...credential, expires: Date.now() + ONE_YEAR_MS };
        },
        async toAuth(credential: OAuthCredential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: materializeModels(models),
    api: {
      stream: streamDevin,
      streamSimple: streamDevin,
    },
  });
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createDevinProvider(pi, FALLBACK_MODELS));

  pi.on("session_start", async (_event, ctx) => {
    effectiveBaseUrl = ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ?? DEFAULT_BASE_URL;
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (apiKey) await refreshDevinProvider(pi, apiKey, effectiveBaseUrl);
    } catch {
      // Keep the provider's current models.
    }
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin auth, endpoint, and optional CLI status",
    handler: async (_args, ctx) => {
      const [apiKey, bin, version] = await Promise.all([
        ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID),
        whichDevin(),
        devinVersion(),
      ]);
      const baseUrl = ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ?? DEFAULT_BASE_URL;
      ctx.ui.notify(
        [
          apiKey ? "Auth: stored in Pi auth.json" : "Auth: not configured. Run /login devin",
          `Endpoint: ${baseUrl}`,
          bin ? `CLI: ${bin}` : "CLI: not installed (only required for first login)",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
        ].join("\n"),
        apiKey ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Reload the Devin Local model catalog",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
        if (!apiKey) {
          ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
          return;
        }
        effectiveBaseUrl = ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl ?? DEFAULT_BASE_URL;
        const count = await refreshDevinProvider(pi, apiKey, effectiveBaseUrl);
        ctx.ui.notify(`Devin: loaded ${count} families.`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Devin refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    effectiveBaseUrl = DEFAULT_BASE_URL;
  });
}
