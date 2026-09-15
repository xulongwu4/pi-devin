# AGENTS.md — pi-devin

Pi package that registers the native `devin` provider. `/login devin` runs the Devin PKCE browser flow natively (no Devin CLI); runtime auth comes from Pi, while catalog discovery and inference are direct. Pi remains the harness.

## Layout

```
extensions/index.ts   # native provider, Pi auth, /login, status, refresh
src/catalog.ts        # GetCliModelConfigs → cached DevinCatalog
src/models.ts         # DevinCatalog → ProviderModelConfig[]
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history
```

## Contract

- `/login devin` must run the Devin PKCE flow natively: browser to `app.devin.ai/devin/account/login`, localhost `/callback` for the code, exchange via `ExchangeDevinCLIPKCECode`, then persist the returned API key in Pi's native auth store. A paste-API-key fallback must remain. No Devin CLI dependency.
- Runtime auth must come from Pi's resolved `auth.json` credential.
- `models.json` `providers.devin.baseUrl` must compose above the native provider for inference only; catalog fetch always uses `https://server.codeium.com`.
- Model IDs must come from `GetCliModelConfigs`, not a hardcoded cloud allowlist.
- Catalog transport/decode failures must fall back to `$PI_CODING_AGENT_DIR/devin/models.json`.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`.
