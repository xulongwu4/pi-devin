import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { authStatus, loginWithCli, readCredentials, type DevinCredentials } from "../src/credentials.js";
import { whichDevin, devinVersion } from "../src/cli.js";
import { loadCatalog } from "../src/catalog.js";
import { FALLBACK_MODELS, modelsFromCatalog } from "../src/models.js";
import { CLIENT_IDE, CLIENT_VERSION } from "../src/metadata.js";
import { streamDevin } from "../src/stream.js";

const PROVIDER_ID = "devin";
const PLACEHOLDER_BASE_URL = "https://server.codeium.com";

let _pi: ExtensionAPI | null = null;

async function refreshDevinProvider(pi: ExtensionAPI, credentials: DevinCredentials): Promise<number> {
  const catalog = await loadCatalog({
    apiKey: credentials.apiKey,
    apiServerUrl: credentials.apiServerUrl,
  });
  const models = modelsFromCatalog(catalog);
  registerDevinProvider(pi, models);
  return models.length;
}

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Devin Local",
    api: "devin-local",
    baseUrl: PLACEHOLDER_BASE_URL,
    models,
    oauth: {
      name: "Devin CLI",
      async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const creds = await loginWithCli();
        if (_pi) {
          try {
            await refreshDevinProvider(_pi, creds);
          } catch {
            // keep current models
          }
        }
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const creds = readCredentials();
        if (!creds) return credentials;
        return {
          refresh: "",
          access: creds.apiKey,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      },
      getApiKey(credentials: OAuthCredentials): string {
        return readCredentials()?.apiKey || credentials.access;
      },
      modifyModels(models: Model<Api>[], _credentials: OAuthCredentials): Model<Api>[] {
        return models;
      },
    },
    streamSimple: streamDevin,
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  _pi = pi;
  registerDevinProvider(pi, FALLBACK_MODELS);

  try {
    const credentials = readCredentials();
    if (credentials) await refreshDevinProvider(pi, credentials);
  } catch {
    // fallback models already registered
  }

  pi.on("session_start", async () => {
    try {
      const credentials = readCredentials();
      if (!_pi || !credentials) return;
      await refreshDevinProvider(_pi, credentials);
    } catch {
      // keep current models
    }
  });

  pi.registerCommand("devin-status", {
    description: "Show Devin CLI auth + binary status",
    handler: async (_args, ctx) => {
      const bin = await whichDevin();
      const version = await devinVersion();
      const status = await authStatus();
      ctx.ui.notify(
        [
          bin ? `CLI: ${bin}` : "CLI: not installed (only required for first login)",
          version ? `CLI version: ${version}` : "CLI version: unknown",
          `Client identity: ${CLIENT_IDE} ${CLIENT_VERSION}`,
          status.loggedIn ? "Auth: signed in via Devin CLI" : "Auth: not signed in. Run /login devin or `devin auth login`",
        ].join("\n"),
        status.loggedIn ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("devin-refresh", {
    description: "Reload the Devin Local model catalog",
    handler: async (_args, ctx) => {
      try {
        const credentials = readCredentials();
        if (!credentials) {
          ctx.ui.notify("Devin: not signed in. Run /login devin", "warning");
          return;
        }
        const count = await refreshDevinProvider(pi, credentials);
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
    _pi = null;
  });
}
