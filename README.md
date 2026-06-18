# Kleap — website infrastructure for AI agents

Drive [Kleap](https://kleap.co) from **any MCP client** — Claude Desktop, Cursor,
or ChatGPT. Your agent describes a site; Kleap builds it (hosting, database and
auth included), connects a domain, and publishes it with the **verified-live
guarantee**.

> Your agent builds. Kleap ships it live — and only ever reports a site as
> online once it is **provably serving**.

This package is a thin [Model Context Protocol](https://modelcontextprotocol.io)
server that wraps Kleap's public REST API (`/api/v1/*`). No secrets live here —
it authenticates with your own Kleap API key, passed via an environment
variable.

## Quick start

1. **Get an API key** — at [kleap.co](https://kleap.co) → **Settings → API key →
   MCP / API access → Generate MCP key**. It looks like `kleap_live_sk_...`.

2. **Add it to your MCP client** (no install step — `npx` fetches it):

   **Claude Desktop** — `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "kleap": {
         "command": "npx",
         "args": ["-y", "kleap"],
         "env": { "KLEAP_API_KEY": "kleap_live_sk_..." }
       }
     }
   }
   ```

   **Cursor** — `.cursor/mcp.json`: same shape.

   **ChatGPT & hosted agents** — no local process needed. Add the hosted
   connector at `https://kleap.co/api/mcp` and authorize with OAuth (or your key).

3. Restart the client and ask your agent: *"Build me a site for X,"* *"change
   the headline to Y,"* *"publish it."*

## Tools

| Tool | What it does |
|------|--------------|
| `create_app` | Create a site from a prompt → returns a task |
| `modify_app` | Ask the app's AI to change it → returns a task |
| `check_task` | Poll a create/modify task to completion |
| `retry_task` | Resume a failed/stalled build from partial state |
| `publish_app` | Publish with verified-live (live-or-rollback, never a false "online") |
| `get_publish_status` | Is it actually published + live |
| `search_domains` | Find available domains (purchase stays user-confirmed in Kleap) |
| `check_domain` | A domain's connection / DNS status |
| `connect_domain` | Connect a domain you already own to a published app |
| `list_apps` / `get_app` | List your apps / one app's details |
| `list_app_files` | An app's source files |
| `get_credits` | Remaining credit balance + plan |

All app arguments are snake_case: `app_id`, `task_id`, `prompt`, `message`,
`visibility`.

## The verified-live guarantee

Most tools tell the agent "it's online" the moment a deploy is *requested*.
Kleap reports a site as published **only once the new version is provably
serving** at its live URL — otherwise it rolls back and reports "not confirmed
live." An agent can never hand your user a dead link.

If `check_task` reports `failed` (e.g. a transient generation stall), call
`retry_task` with the same `task_id` to resume from where it stopped — partial
work is preserved.

## Run it directly

```bash
KLEAP_API_KEY=kleap_live_sk_... npx kleap
# → [kleap-mcp] ready (stdio) → https://kleap.co. Tools: list_apps, ...
```

Override the API base with `KLEAP_API_URL` (default `https://kleap.co`).

## Security

This package contains no credentials. Your `KLEAP_API_KEY` stays in your local
MCP client config and is sent only to `https://kleap.co`. Never commit it to a
public repo. Revoke or rotate keys anytime from **Settings → API key**.

## Links

- Kleap: https://kleap.co
- MCP & CLI page: https://kleap.co/mcp
- Issues: https://github.com/Kleap-co/kleap/issues

MIT © Kleap
