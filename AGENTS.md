# AGENTS.md — pi-devin

Pi package that registers the `devin` provider. The local Devin CLI is used for first login only; catalog discovery and inference are direct. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin` for first login/status
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/catalog.ts        # GetCliModelConfigs → cached DevinCatalog
src/models.ts         # DevinCatalog → ProviderModelConfig[]
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history
```

## Contract

- `/login devin` must call `devin auth login` when credentials are missing, not a custom Windsurf paste flow.
- Model IDs must come from `GetCliModelConfigs`, not a hardcoded cloud allowlist.
- Catalog transport/decode failures must fall back to `$PI_CODING_AGENT_DIR/devin/models.json`.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`.
