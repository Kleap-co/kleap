#!/usr/bin/env node
/**
 * Kleap MCP server (v1 — stdio transport, API-key auth).
 *
 * Lets ANY MCP client (Claude Desktop, Cursor, or ChatGPT via a bridge) drive
 * Kleap: create / list / inspect apps, edit them through Kleap's own AI, and
 * PUBLISH with the verified-live guarantee. It does this by wrapping the
 * existing public REST API (`/api/v1/*`) — the MCP is just another client onto
 * the same backend, exactly like the web app or the WhatsApp integration. No
 * new write path, so every Kleap convention/guardrail still applies server-side.
 *
 * Auth: a Kleap API key, sent as `Authorization: Bearer kleap_live_sk_...`.
 * Transport: stdio (the client spawns this process).
 *
 * Run:
 *   KLEAP_API_KEY=kleap_live_sk_... node mcp/kleap-mcp-server.mjs
 *   (optional) KLEAP_API_URL=https://kleap.co   # default
 *
 * PHASE 2 (deliberately NOT here — see the agent-platform plan):
 *   remote HTTP transport + OAuth (so users add it without a local process),
 *   registry listing + one-click install, and metering/quota surfacing. This
 *   file is the working keystone of the agent interface: it proves the whole
 *   path (external agent → Kleap backend → verified-live publish) end to end.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_URL = (process.env.KLEAP_API_URL || "https://kleap.co").replace(
  /\/$/,
  "",
);
const API_KEY = process.env.KLEAP_API_KEY;

if (!API_KEY) {
  console.error(
    "[kleap-mcp] Missing KLEAP_API_KEY (expected a Bearer kleap_live_sk_... key).",
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

/**
 * Thin REST caller — auth, timeout, bounded retry, JSON/HTML-aware errors.
 * Retries transient failures (5xx / 429 / network / timeout) with backoff.
 * Never surfaces raw HTML error pages to the agent; extracts error.code/message.
 */
async function api(method, path, body, { retries = 2, timeoutMs = 60000 } = {}) {
  const url = `${API_URL}/api/v1${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(t);

      const ctype = res.headers.get("content-type") || "";
      const text = await res.text();
      const isJson = ctype.includes("application/json");
      const parsed = isJson ? safeJson(text) : null;

      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        const detail =
          parsed?.error?.message ||
          parsed?.message ||
          (isJson
            ? JSON.stringify(parsed).slice(0, 300)
            : `non-JSON ${ctype || "response"} (likely an unhandled route)`);
        const code = parsed?.error?.code ? ` [${parsed.error.code}]` : "";
        throw new Error(`Kleap API ${res.status}${code} on ${method} ${path}: ${detail}`);
      }

      if (!isJson) {
        throw new Error(`Kleap API returned non-JSON (${ctype}) for ${method} ${path}`);
      }
      return parsed;
    } catch (e) {
      clearTimeout(t);
      lastErr =
        e?.name === "AbortError"
          ? new Error(`Kleap API timeout after ${timeoutMs}ms on ${method} ${path}`)
          : e;
      const retryable =
        e?.name === "AbortError" ||
        e?.code === "ECONNRESET" ||
        e?.code === "ETIMEDOUT" ||
        /fetch failed|network/i.test(e?.message || "");
      if (retryable && attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

const num = (description) => ({ type: "number", description });
const str = (description) => ({ type: "string", description });
const obj = (properties, required) => ({
  type: "object",
  properties: properties || {},
  ...(required ? { required } : {}),
  additionalProperties: false,
});

/**
 * The tool surface. Each maps 1:1 to an existing /api/v1 endpoint.
 *
 * Tool names + argument names are kept IDENTICAL to the hosted remote server
 * (/api/mcp) on purpose, so an agent (or a tutorial) written for one transport
 * works verbatim on the other. Arguments are snake_case (app_id, task_id).
 */
const TOOLS = [
  {
    name: "list_apps",
    description:
      "List the Kleap apps (websites) owned by the authenticated account, newest first. Returns a `pagination` object {total, limit, offset, has_more, next_offset}: the server caps `limit` at 100, so when `has_more` is true, page with `next_offset`. To find ONE site by its domain / URL / slug, use find_app instead of paging through everything.",
    inputSchema: obj({
      limit: num("Max apps to return (default 50, server max 100)."),
      offset: num("Pagination offset (default 0)."),
      q: str("Optional filter on app name or slug (substring match)."),
    }),
    handler: ({ limit, offset, q } = {}) => {
      const params = new URLSearchParams();
      if (limit != null) params.set("limit", String(limit));
      if (offset != null) params.set("offset", String(offset));
      if (q) params.set("q", q);
      const qs = params.toString();
      return api("GET", `/apps${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "find_app",
    description:
      "Resolve a website the user names by its ADDRESS — a custom domain (\"serrureriesk.ch\"), a kleap.io URL (\"mysite.kleap.io\"), or a bare slug (\"mysite\") — to one of your apps in ONE call. Use this FIRST whenever the user refers to a site by its domain/URL instead of an app id, then pass the returned app_id to get_app / modify_app / publish_app. Do not list every app and scan.",
    inputSchema: obj(
      { query: str("A domain, URL, or slug, e.g. 'serrureriesk.ch'.") },
      ["query"],
    ),
    handler: ({ query }) =>
      api("GET", `/apps/resolve?q=${encodeURIComponent(query)}`),
  },
  {
    name: "get_app",
    description:
      "Get one Kleap app's metadata: status, slug, production_url, published state.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}`),
  },
  {
    name: "list_app_files",
    description: "List the source files of a Kleap app.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}/files`),
  },
  {
    name: "create_app",
    description:
      "Create a new Kleap website from a natural-language prompt. Returns a task — poll check_task until it completes.",
    inputSchema: obj(
      {
        prompt: str("What the website should be."),
        visibility: str("'public' (discoverable) or 'personal' (private)."),
      },
      ["prompt"],
    ),
    handler: ({ prompt, visibility }) =>
      api("POST", "/apps", { prompt, visibility: visibility || "personal" }),
  },
  {
    name: "modify_app",
    description:
      "Ask a Kleap app's AI to change it (edit copy, add a section, fix a bug). Returns a task — poll check_task.",
    inputSchema: obj(
      { app_id: num("The app id."), message: str("The change to make.") },
      ["app_id", "message"],
    ),
    handler: ({ app_id, message }) =>
      api("POST", `/apps/${app_id}/messages`, { message }),
  },
  {
    name: "rename_app",
    description:
      "Rename an app's display name. This does NOT change its URL — the live address ({slug}.kleap.io) and any links to it stay intact. (There is no delete tool, by design.)",
    inputSchema: obj(
      { app_id: num("The app id."), name: str("The new display name.") },
      ["app_id", "name"],
    ),
    handler: ({ app_id, name }) =>
      api("PATCH", `/apps/${app_id}`, { name }),
  },
  {
    name: "check_task",
    description:
      "Poll an async task (app creation or edit). Returns status + result when done. If status is 'failed' (e.g. a transient generation stall), call retry_task with the same task_id to resume — don't start over.",
    inputSchema: obj({ task_id: str("The task id.") }, ["task_id"]),
    handler: ({ task_id }) => api("GET", `/tasks/${task_id}`),
  },
  {
    name: "retry_task",
    description:
      "Resume a failed or stalled create/modify task from where it stopped (partial files are preserved). Use this when check_task reports 'failed' before starting a brand-new create_app. Returns a fresh task — poll check_task on the new task_id.",
    inputSchema: obj({ task_id: str("The failed task id to resume.") }, [
      "task_id",
    ]),
    handler: ({ task_id }) => api("POST", `/tasks/${task_id}/retry`, {}),
  },
  {
    name: "publish_app",
    description:
      "Publish a Kleap app to its live URL with the VERIFIED-LIVE guarantee: it is only reported live once the new version is provably serving (otherwise it reports 'not confirmed live' — never a false positive). Returns a deploy handle — poll get_publish_status.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("POST", `/apps/${app_id}/publish`, {}),
  },
  {
    name: "get_publish_status",
    description:
      "Check whether an app is actually published and live (production_url + published state).",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}/publish`),
  },
  {
    name: "get_credits",
    description:
      "Check the authenticated account's remaining credit balance and plan.",
    inputSchema: obj(),
    handler: () => api("GET", "/account/credits"),
  },
  {
    name: "search_domains",
    description:
      "Search for available domains for a site (e.g. 'mybakery'). Returns available names across TLDs. NOTE: agents cannot buy a domain — purchase is confirmed by the user in Kleap. Use connect_domain for a domain the user already owns.",
    inputSchema: obj(
      {
        query: str("Base name to search, without a TLD (e.g. 'mybakery')."),
        tlds: {
          type: "array",
          items: { type: "string" },
          description: "Optional TLDs to check, e.g. ['.com', '.io', '.ch'].",
        },
      },
      ["query"],
    ),
    handler: ({ query, tlds }) => api("POST", "/domains/search", { query, tlds }),
  },
  {
    name: "check_domain",
    description:
      "Check a domain's connection / DNS status for a Kleap app.",
    inputSchema: obj({ domain: str("The domain, e.g. 'mybakery.com'.") }, [
      "domain",
    ]),
    handler: ({ domain }) =>
      api("GET", `/domains/${encodeURIComponent(domain)}/check`),
  },
  {
    name: "connect_domain",
    description:
      "Connect a domain the user ALREADY OWNS to a published Kleap app (sets up routing + automatic TLS). The app must be published first; the user points the domain's A record to Kleap. Does not buy anything.",
    inputSchema: obj(
      {
        app_id: num("The app id (must be published)."),
        domain: str("The domain to connect, e.g. 'mybakery.com'."),
      },
      ["app_id", "domain"],
    ),
    handler: ({ app_id, domain }) =>
      api("POST", "/domains/connect", { app_id, domain }),
  },
];

const server = new Server(
  { name: "kleap", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(req.params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${e?.message || e}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[kleap-mcp] ready (stdio) → ${API_URL}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
);
