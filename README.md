# pi-devin

A [Pi](https://pi.dev) package that uses **Devin Local** models inside Pi.

Pi stays the harness. `/login devin` runs the Devin PKCE browser flow natively (no Devin CLI). After credentials exist, pi-devin fetches the Devin Local catalog and streams completions directly. This is not an ACP integration and does not use Zed.

## Why this exists

`pi-devin-auth` treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Those models are available through Devin Local. First login stores the credential in Pi's `auth.json`; catalog discovery and inference then use that so Pi's tools, sessions, and UI stay in charge.

## Requirements

- Pi Coding Agent 0.80+
- Node 18+

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

`/login devin` opens a browser to `app.devin.ai/auth/cli/continue`, receives the code on a localhost `/callback`, and stores an OAuth credential in Pi's `auth.json`.

Override the inference API server in Pi's `models.json`:

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

- `/devin-status` — Pi auth and effective endpoint
- `/devin-refresh` — fetch the Devin Local model catalog directly

## [0.3.1]
### Fixed
- Devin inference now invokes Pi's request/response hooks, supporting payload inspection, mutation, and replacement without exposing credentials.
- Invalid top-level payloads fail clearly before network requests; stream start follows response setup, and hook failures or cancellation clean up unread responses.

## [0.3.0] - 2026-09-26
### Changed
- Model costs now come from the live catalog's per-model prices (Input / Cached input / Output per 1M tokens), matching `devin models list`.
- Free models (for example SWE-2) show `(Free)` in their name, e.g. `SWE-2 (Free)`. Model ids are unchanged; type `free` in `/model` to find them, since the picker search also matches names.

## [0.2.0] - 2026-09-17
### Changed
- Enum-backed models now use readable family IDs, such as `devin/gpt-5.2`, instead of raw backend IDs like `devin/MODEL_GPT_5_2_LOW`. Requests still use the original backend IDs. Reselect saved models after upgrading.

Pi's model picker displays model IDs. Enum-backed models now use readable family IDs (for example, `devin/gpt-5.2` instead of `devin/MODEL_GPT_5_2_LOW`), while requests still use the original backend IDs. After upgrading, run `/reload` and reselect the family with `/model`; choose its thinking level separately. Saved settings or sessions referencing an old `MODEL_…` ID are not automatically migrated and may warn or fall back, so update those selections to the new family ID.

Catalog discovery always calls `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs`, independent of `models.json`. The last successful catalog is cached at `$XDG_CACHE_HOME/pi/devin/models.json` (default: `~/.cache/pi/devin/models.json`). Network, timeout, HTTP, or decode failures fall back to that cache; a missing or corrupt cache falls back to the bundled models.

## Inference hooks

Devin supports Pi's `before_provider_request` (`onPayload`) and `after_provider_response` (`onResponse`) hooks for chat inference, not login, JWT, or catalog requests.

The payload is a structured object with `modelUid`, `messages`, `tools`, `maxOutputTokens`, and `temperature`, before protobuf encoding. Hooks may mutate it in place or return a replacement; returning `undefined` keeps it. The top-level payload must have a non-empty string `modelUid` and a `messages` array; optional `tools` must be an array, `maxOutputTokens` a positive safe integer, and `temperature` a finite number (sent clamped to at least 0.01). Invalid top-level payloads fail before any network request. Tool `parameters` are shown as Pi supplied them; JSON Schema type arrays, and `type` next to `anyOf`, are rewritten into `anyOf` branches after the hook, during encoding, because Devin-hosted Gemini rejects them. Schemas with `$id`, `$anchor`, `$dynamicAnchor`, `$dynamicRef`, `$recursiveRef`, or a `$ref` fragment other than `#`, `#/$defs/<name>`, `#/definitions/<name>` are sent unchanged. A node is also left as-is when its `anyOf` cannot be merged safely (a branch with its own `type`, `anyOf`, or `unevaluated*`; a keyword on both the node and a branch; paired keywords such as `properties`/`additionalProperties` or `if`/`then` split between them; `unevaluated*` on the node), or when it has `anyOf` with constraints but no `type`; Gemini may still reject those. Credentials and transport metadata are excluded. This is Devin's format, not Anthropic/OpenAI JSON, so extensions must handle `devin-local` explicitly when modifying it.

By the time `onPayload` runs, later system updates are already user-role `<system>` text and cannot be distinguished from user-typed blocks using the payload alone. Hooks needing the original roles should use Pi’s context hooks before provider mapping. Preserve the encoded update messages when modifying payloads: introducing mid-history `role: "system"` messages invokes the legacy encoder’s merging behavior, which can move their text into a later user message.

Response hooks receive `{ status, headers }` before the body is read, including HTTP error responses. Both callbacks are awaited and receive the selected model as their second argument. `start` is emitted only after the response hook succeeds and the response is usable. Callback failures terminate inference with an error; cancellation is checked when each hook completes, producing an aborted result and cancelling any unread chat response.

## Prompt updates and caching

The initial system prompt keeps its existing encoding. Later Pi system messages become standalone `<system>`-wrapped user messages, using Pi’s renderer to identify section replacements and removals. Updates wait until outstanding tool results arrive, or until the next user/assistant turn or transcript end closes an interrupted batch. Missing results no longer block later updates; existing orphaned tool-call history is preserved without synthesizing results. Legacy transcripts without a leading system message render their first system snapshot in place. Devin’s transport has no native system role; this uses the existing instruction envelope rather than moving updates to the front of the conversation.

**Instruction trust:** `<system>` is text, not an authenticated role or security boundary. A user can type an identical block; later updates extend the initial prompt’s existing trust limitation to later turns. Keep untrusted content separate in the application and do not rely on these delimiters for privilege enforcement. Models can also acknowledge an update instead of continuing the task; verify behavior on the particular Devin model you use.

Once the initial prompt is paired with a user message, prompt-only updates preserve earlier encoded messages, including when replaying a restored transcript. Empty/tool-only deltas add no instruction message; tool declarations still reflect the current tool set. Changing tool definitions (often alongside rules), compaction, or extensions rewriting the initial prompt can still invalidate caching. Pi upgrades can also change the renderer’s wording for historical updates. Server cache hits are not guaranteed. Existing sessions may have a one-time cache miss when switching from the old collapsed representation. System-only requests retain the existing initial-prompt merging behavior and are not covered by the prefix guarantee.

## What this is / is not

| This package | Not this package |
|---|---|
| Pi is the agent | Devin taking over the session |
| Pi `auth.json` after browser PKCE login | Fake Windsurf OAuth paste flow |
| Live Devin Local families (Opus 5, Fable 5, Sol, …) | Hardcoded cloud allowlist |
| Completions streamed into Pi tools | An editor host for Devin |

## Changelog

### v0.3.2

- **Fixed:** prompt-only instruction updates preserve earlier conversation bytes instead of rewriting the initial prompt.
- **Fixed:** interrupted tool batches release buffered updates so sessions can continue after cancellation or resume.
- **Documented:** instruction-envelope trust, hook behavior, and cache limitations.

## Publish

This is a standard Pi package (`keywords: ["pi-package"]` + `pi.extensions`). After you push to npm with that keyword, it can show up on [pi.dev/packages](https://pi.dev/packages).

## License

MIT. Unofficial. Not affiliated with Cognition.
