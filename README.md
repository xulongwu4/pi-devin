# pi-devin

A [Pi](https://pi.dev) package that uses **Devin Local** models inside Pi.

Pi stays the harness. The [Devin CLI](https://docs.devin.ai/cli) is used for first login only; after credentials exist, pi-devin fetches the Devin Local catalog and streams completions directly. This is not an ACP integration and does not use Zed.

## Why this exists

`pi-devin-auth` treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Those models are available through Devin Local. On first login this package imports the CLI credential into Pi's `auth.json`; catalog discovery and inference then use Pi's stored credential directly so Pi's tools, sessions, and UI stay in charge.

## Requirements

- Pi Coding Agent 0.80+
- The [Devin CLI](https://docs.devin.ai/cli) for first login, or an existing `devin` entry in Pi's `auth.json`
- Node 18+

For first login, the CLI binary is resolved in this order:

1. `$DEVIN_CLI`
2. `~/.local/bin/devin`, Homebrew, `/usr/local/bin/devin`
3. Devin.app's bundled `devin` binary
4. `which devin`

## Install

From git:

```bash
pi install git:github.com/kashyab12/pi-devin
```

After npm publish:

```bash
pi install npm:pi-devin
```

Local checkout:

```bash
pi install /Users/kashyab/pi-devin
```

Restart Pi or run `/reload`.

## Usage

```text
/login devin
/model devin/claude-opus-5-high
/model devin/claude-5-fable-high
/model devin/gpt-5-6-sol-high
```

`/login devin` runs `devin auth login` when needed, then stores the resulting API key under `devin` in Pi's `auth.json`. After that succeeds, inference and catalog refresh do not read `credentials.toml`, so the file and CLI may be removed.

Override the API server for both catalog and inference in Pi's `models.json`:

```json
{
  "providers": {
    "devin": {
      "baseUrl": "http://127.0.0.1:8787/route_to/https://server.codeium.com"
    }
  }
}
```

Commands:

- `/devin-status` — Pi auth, effective endpoint, and optional CLI status
- `/devin-refresh` — fetch the Devin Local model catalog directly

The last successful direct catalog is cached at `$PI_CODING_AGENT_DIR/devin/models.json` (default: `~/.pi/agent/devin/models.json`). Network, timeout, HTTP, or decode failures fall back to that cache; a missing or corrupt cache falls back to the bundled models.

## What this is / is not

| This package | Not this package |
|---|---|
| Pi is the agent | Devin taking over the session |
| Pi `auth.json` after CLI-assisted first login | Fake Windsurf OAuth paste flow |
| Live Devin Local families (Opus 5, Fable 5, Sol, …) | Hardcoded cloud allowlist |
| Completions streamed into Pi tools | An editor host for Devin |

## Publish

This is a standard Pi package (`keywords: ["pi-package"]` + `pi.extensions`). After you push to npm with that keyword, it can show up on [pi.dev/packages](https://pi.dev/packages).

## License

MIT. Unofficial. Not affiliated with Cognition.
