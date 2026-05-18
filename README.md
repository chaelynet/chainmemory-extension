# chainmemory-extension

Browser extension for [ChainMemory](https://chainmemory.ai) — save and recall AI conversations across ChatGPT, Claude, Gemini, and Perplexity.

## What it does

- **Save**: a "Save to ChainMemory" button appears on every AI response. One click writes the conversation to the ChainMemory blockchain permanently.
- **Inject** (new in v2.1.0): a floating "Inject memory" button on every supported AI page pulls your verified memory from ChainMemory and pastes it into the chat input, giving the AI continuity with what you discussed on other platforms.
- **Verify**: every saved memory eventually gets cryptographically anchored on-chain. Verified memories are marked and link to a public verification page.

## Supported platforms

- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Claude (`claude.ai`)
- Gemini (`gemini.google.com`)
- Perplexity (`www.perplexity.ai`)

## Installation (unpacked, for development)

1. Clone this repo:
   ```bash
   git clone https://github.com/chaelynet/chainmemory-extension.git
   cd chainmemory-extension
   ```
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Click the ChainMemory icon in the toolbar to set up your API key

## Configuration

When you first open the popup, you have two options:

- **Generate API key automatically**: creates a new wallet on the ChainMemory blockchain. Save the key in a password manager — there is no recovery.
- **I already have a key**: paste an existing `aic_...` key (e.g. from another browser).

After setup, claim free AIC tokens at [faucet.chainmemory.ai](https://faucet.chainmemory.ai) so you can write to the blockchain.

## How memory injection works

1. Click the floating **"Inject memory"** button (bottom-left on any supported AI page).
2. The extension calls `GET https://api.chainmemory.ai/v1/memory/context` with your API key.
3. A preview panel opens showing your summary, recent memories, and verification status.
4. Click **Inject into prompt** to paste the formatted context at the top of the chat input.
5. If the platform's input cannot be detected (rare — happens when the platform changes its HTML), the context is copied to your clipboard as a fallback.

You can tune what gets injected from the popup:
- **Memories per injection**: 5, 10, 20, or 50 (default 10)
- **Verified only**: include only memories anchored on the blockchain

## File structure

```
chainmemory-extension/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker (opens faucet on install)
├── content.js             # Save buttons + floating Inject button
├── content.css            # Brand-styled UI
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic (setup, history, settings)
└── icons/                 # 16/48/128 px brand icons
```

## Version history

- **2.1.0** (May 2026) — adds `Inject memory` floating button and panel preview, supports user-configurable injection limit and verified-only filter.
- **2.0.x** — chain migration to ID 202604, native AIC support, Save flow on 4 platforms.
- **1.0.x** — initial release: Save to ChainMemory on Claude.

## Related projects

- [chainmemory-mcp](https://www.npmjs.com/package/chainmemory-mcp) — MCP server for Claude Desktop, Cursor, and other MCP-compatible AIs.
- [chainmemory-sdk](https://www.npmjs.com/package/chainmemory-sdk) — JavaScript SDK.
- [chainmemory](https://pypi.org/project/chainmemory/) — Python SDK.

## Privacy

- Your API key is stored in `chrome.storage.sync` (encrypted and synced across your Chrome instances).
- The extension only communicates with `api.chainmemory.ai`.
- No analytics, no telemetry, no ads.

## Links

- Website: https://chainmemory.ai
- Faucet: https://faucet.chainmemory.ai
- API docs: https://api.chainmemory.ai/llms.txt
- Explorer: https://chainmemory.ai

## License

MIT — see [LICENSE](./LICENSE).
