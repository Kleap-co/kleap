# Kleap — website infrastructure for AI agents

[![CI](https://github.com/Kleap-co/kleap/actions/workflows/ci.yml/badge.svg)](https://github.com/Kleap-co/kleap/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-server-2563eb)](https://modelcontextprotocol.io)
[![15 tools](https://img.shields.io/badge/tools-15-ff0055)](#tools)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

> **Your agent builds. Kleap ships it live.**
> Let any AI agent — Claude, ChatGPT, Cursor — build, edit and **publish real,
> live websites** for you. Hosting, database, auth and domains included.

An alternative to Lovable / v0 / Bolt — except it's driven by **your** agent, and
every publish comes with the **verified-live guarantee**: a site is only ever
reported online once it is *provably serving* — never a hallucinated dead link.

![A real, unedited run: an agent writes a page with write_files, publishes, and it is live and serving in seconds.](./assets/demo.gif)

> *Above: a real run — your agent writes the code with `write_files`, `publish_app` builds & deploys it, and the page is live in seconds. Or just ask Kleap's AI in plain English.*

This is a thin [Model Context Protocol](https://modelcontextprotocol.io) server
that wraps Kleap's public REST API. **No secrets live in this package** — it reads
your own `KLEAP_API_KEY` from the environment and talks only to `kleap.co`.

---

## Quick start

**1. Get an API key** — at [kleap.co](https://kleap.co) → **Settings → API key →
MCP / API access → Generate MCP key** (`kleap_live_sk_...`).

**2. Add Kleap to your AI client:**

<details open>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

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
</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code></summary>

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
</details>

<details>
<summary><b>Claude Code</b> — one command</summary>

```bash
claude mcp add kleap -e KLEAP_API_KEY=kleap_live_sk_... -- npx -y kleap
```
</details>

<details>
<summary><b>Cline / Roo (VS Code)</b> — <code>cline_mcp_settings.json</code></summary>

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
</details>

<details>
<summary><b>Windsurf</b> — <code>~/.codeium/windsurf/mcp_config.json</code></summary>

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
</details>

<details>
<summary><b>ChatGPT &amp; hosted agents</b> — no local process</summary>

Add the hosted connector at **`https://kleap.co/api/mcp`** and authorize with
OAuth (or paste your `kleap_live_sk_` key). Same tools, no install.
</details>

> Every stdio config is identical — `npx -y kleap` + a `KLEAP_API_KEY` env var —
> so any MCP client works.

**Least-privilege keys:** when you generate a key, pick a scope — **Read-only**
(inspect sites, no changes), **Build**, or **Full**. Buying domains is never
included by default. Give a read-only agent a read-only key.

**3. Restart the client and just ask:**

> *"Build me a one-page site for my bakery, publish it, and give me the live URL."*
> *"Add a contact form to my site and redeploy."*
> *"Change the headline to 'Roasted slow' and publish."*

Works with **any MCP-compatible agent**: Claude · ChatGPT · Cursor · Claude Code · Codex.

---

## Tools

**Find & build** — `find_app` · `create_app` · `modify_app` · `write_files` · `rename_app` · `check_task` · `retry_task`
**Publish & domains** — `publish_app` · `get_publish_status` · `search_domains` · `check_domain` · `connect_domain`
**Account** — `list_apps` · `get_app` · `list_app_files` · `get_credits`

| Tool | What it does |
|------|--------------|
| `find_app` | Resolve a domain / URL / slug → app_id in one call |
| `create_app` | Create an Astro site from a prompt → returns a task (auto-deploys live) |
| `modify_app` | Ask the app's AI to change it → returns a task |
| `write_files` | Write exact files directly (**your** code, deterministic) → then `publish_app` |
| `rename_app` | Rename the display name (URL stays the same) |
| `check_task` | Long-poll a create/modify task to completion (`wait` up to 50s) |
| `retry_task` | Resume a failed/stalled build from partial state (new task_id) |
| `publish_app` | Publish with verified-live (live-or-rollback, never a false "online") |
| `get_publish_status` | Confirm a site is actually published + live |
| `search_domains` | Find available domains (purchase stays user-confirmed in Kleap) |
| `connect_domain` | Connect a domain you already own to a live app |
| `check_domain` | A domain's connection / DNS status |
| `list_apps` / `get_app` / `list_app_files` | Your apps, an app's details, its files (read-only) |
| `get_credits` | Remaining credit balance + plan |

App arguments are snake_case: `app_id`, `task_id`, `prompt`, `message`, `visibility`.

## Recipes

**Two ways to put code on a site — pick per task:**
- **`write_files` (deterministic):** *your* model writes the exact file contents; you push them and Kleap builds + deploys as-is. No Kleap-AI step → no Kleap credits, never stalls. Then `publish_app`. Unlike Lovable/v0/Bolt, your agent can write the code itself.
- **`modify_app` (Kleap's AI):** describe the outcome in plain English and Kleap's AI writes it. Like Lovable's message-passing — kept for when you'd rather it figure out the change.

Either way Kleap hosts it (build, deploy, SSL, DB, auth, domains, verified-live).

- **Edit a site named by its address** — `find_app("mysite.ch")` → `modify_app(app_id, "…")` → `check_task(task_id, wait=45)`.
- **Many pages (programmatic SEO) — BEST:** generate a dynamic route + a data file with your own model and push them in one `write_files`, then `publish_app`:
  > `write_files(app_id, [{ path: "src/pages/[service]/[city].astro", content: … }, { path: "src/data/locations.json", content: … }])` → `publish_app(app_id)`
  Deterministic, scales to thousands, no stall, no credits. (Or ask Kleap's AI to do the same in one `modify_app` — never loop one call per page.)
- **Don't babysit a 5-15 min build** — `check_task` long-polls (default `wait=45`),
  or pass a `webhook_url` to `create_app` / `modify_app` for a fully hands-off flow.
- **A build failed** — `TASK_TIMEOUT`/`STALE_TASK` = transient, call `retry_task`; it
  returns a **new** task_id — poll *that* one. `TASK_FAILED` = read the message, retry once.

## The verified-live guarantee

Most tools tell the agent "it's online" the moment a deploy is *requested*. Kleap
reports a site as published **only once the new version is provably serving** at
its live URL — otherwise it rolls back and reports "not confirmed live." Your
agent can never hand a user a dead link.

If `check_task` reports `failed` (a transient generation stall), call `retry_task`
with that `task_id` to resume from where it stopped — it returns a **new** task_id
to poll, and partial work is kept. Or skip the AI entirely and `write_files` the
exact code yourself, then `publish_app`.

## FAQ

**Is it safe?** Yes. The connection uses *your* private `kleap_live_sk_` key; an
agent can only touch your own Kleap apps. The key stays in your local client
config, is sent only to `kleap.co` over HTTPS, and is revocable anytime in
**Settings → API key**. Nothing is written to disk.

**How much does it cost?** Connecting is free. Builds and edits use Kleap credits
(`get_credits` reports your balance) — see [pricing](https://kleap.co/pricing).

**Which agents work?** Any MCP client: Claude Desktop, Claude Code, Cursor,
ChatGPT (hosted connector), and others.

## Requirements & run

Node ≥ 18. Run it directly:

```bash
KLEAP_API_KEY=kleap_live_sk_... npx -y kleap
# → [kleap-mcp] ready (stdio) → https://kleap.co. Tools: list_apps, ...
```

Override the API base with `KLEAP_API_URL` (default `https://kleap.co`).
Missing key → the server exits with a clear message.

## Links

- Kleap: https://kleap.co · MCP & CLI page: https://kleap.co/mcp
- Issues & security: https://github.com/Kleap-co/kleap/issues

Maintained by the [Kleap](https://kleap.co) team. MIT © Kleap.
