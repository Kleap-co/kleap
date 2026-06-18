# Security

## Reporting a vulnerability

Email **security@kleap.co** (or open a private security advisory on this repo).
Please do not file public issues for vulnerabilities.

## What's in this package

This MCP server is a thin client over Kleap's public REST API:

- **No credentials are bundled.** It reads `KLEAP_API_KEY` from the environment
  only, and sends it solely to `https://kleap.co` (or `KLEAP_API_URL`) over HTTPS.
- It writes **nothing** to disk and collects **no telemetry**.
- A single runtime dependency: `@modelcontextprotocol/sdk`.

## Handling your API key

- Keep `kleap_live_sk_...` keys in your MCP client config — never commit them.
- Keys are shown once and are **scoped to your own account**; an agent can only
  act on apps you own.
- Rotate or revoke anytime at **kleap.co → Settings → API key**.
- For hosted agents (ChatGPT), prefer the OAuth connector over a pasted key.
