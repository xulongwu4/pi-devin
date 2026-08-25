import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createProvider, type Model, type OAuthCredential } from "@earendil-works/pi-ai";
import { loginWithCli } from "../src/credentials.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import { loadCachedCatalog, loadCatalog } from "../src/catalog.js";
import { modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

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
        name: "Devin CLI",
        isSubscription: true,
        async login(): Promise<OAuthCredential> {
          const credentials = await loginWithCli();
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
