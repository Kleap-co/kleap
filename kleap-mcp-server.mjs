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

const TIMEOUT_MS = Number(process.env.KLEAP_TIMEOUT_MS) || 30000;
const MAX_RETRIES = 2;

// Refuse to send the API key anywhere but kleap.co over HTTPS (or localhost for
// dev). Prevents KLEAP_API_URL from exfiltrating the Bearer key to any host.
{
  let u;
  try {
    u = new URL(API_URL);
  } catch {
    console.error(`[kleap-mcp] Invalid KLEAP_API_URL: ${API_URL}`);
    process.exit(1);
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const isKleap = u.hostname === "kleap.co" || u.hostname.endsWith(".kleap.co");
  if (!isLocal && (u.protocol !== "https:" || !isKleap)) {
    console.error(
      `[kleap-mcp] Refusing to send your API key to ${API_URL}. KLEAP_API_URL must be https and a kleap.co host (set KLEAP_ALLOW_ANY_URL=1 only if you trust it).`,
    );
    if (process.env.KLEAP_ALLOW_ANY_URL !== "1") process.exit(1);
  }
}

/** Extract a clean, agent-readable error (code + useful details) from a body. */
function errorMessage(parsed, status, method, path) {
  if (parsed && typeof parsed === "object") {
    const e = parsed.error || {};
    const code = e.code ? ` [${e.code}]` : "";
    const msg = e.message || parsed.message;
    const d = e.details || {};
    const extra = [];
    if (d.retry_after != null) extra.push(`retry_after=${d.retry_after}s`);
    if (d.balance != null) extra.push(`balance=${d.balance}`);
    if (d.required != null) extra.push(`required=${d.required}`);
    const tail = extra.length ? ` (${extra.join(", ")})` : "";
    if (msg) return `Kleap API ${status}${code}: ${msg}${tail}`;
    return `Kleap API error ${status}${code}${tail}`;
  }
  // Non-JSON (e.g. an HTML 404/5xx page) — don't dump markup at the agent.
  return `Kleap API ${status}: non-JSON response for ${method} ${path} (likely an unknown route)`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin REST caller — auth, timeout, SAFE retry, and clean errors.
 * Retry policy is method-aware: only GET (idempotent) is retried on a network
 * error or 5xx. POST is NEVER retried on a network/timeout failure — the request
 * may have succeeded server-side, and re-firing create/modify/publish would
 * double-create or double-charge. 429 is never retried (its Retry-After can be
 * hours); the wait is surfaced to the agent instead.
 */
async function api(method, path, body, attempt = 0) {
  const idempotent = method === "GET";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const why =
      err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : err?.message;
    // Only retry idempotent GETs — never re-fire a POST that may have landed.
    if (idempotent && attempt < MAX_RETRIES) {
      await sleep(400 * (attempt + 1));
      return api(method, path, body, attempt + 1);
    }
    throw new Error(`Network error calling ${method} ${path}: ${why}`);
  }
  clearTimeout(timer);

  // Retry transient 5xx only for idempotent GETs. Never retry 429.
  if (
    idempotent &&
    [502, 503, 504].includes(res.status) &&
    attempt < MAX_RETRIES
  ) {
    await sleep(400 * (attempt + 1));
    return api(method, path, body, attempt + 1);
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(errorMessage(parsed, res.status, method, path));
  }
  return parsed;
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
      "List the Kleap apps (websites) owned by the authenticated account. Each app includes its custom_domain(s). Use `q` to filter by name or slug. To find a site by its address (domain/URL), prefer find_app.",
    inputSchema: obj({
      q: str("Optional filter on app name or slug (substring match)."),
      limit: num("Max apps to return (default 50, max 100)."),
      offset: num("Pagination offset (default 0)."),
    }),
    handler: ({ q, limit, offset } = {}) => {
      const params = new URLSearchParams();
      if (q) params.set("q", String(q));
      if (limit != null) params.set("limit", String(limit));
      if (offset != null) params.set("offset", String(offset));
      const qs = params.toString();
      return api("GET", `/apps${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "get_app",
    description:
      "Get one Kleap app's metadata: status, slug, production_url, published state.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}`),
  },
  {
    name: "find_app",
    description:
      "Resolve a website the user names by its ADDRESS — a custom domain ('mysite.ch'), a kleap.io URL ('mysite.kleap.io'), or a slug — to its app_id. Use this FIRST when the user refers to a site by its address instead of an app_id (e.g. 'edit mysite.ch'), then pass the returned app_id to get_app / modify_app / publish_app.",
    inputSchema: obj(
      { query: str("A domain, full URL, or slug (e.g. 'mysite.ch').") },
      ["query"],
    ),
    handler: ({ query }) =>
      api("GET", `/apps/resolve?q=${encodeURIComponent(query)}`),
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
        visibility: {
          type: "string",
          enum: ["public", "personal", "workspace"],
          description:
            "'public' (discoverable), 'personal' (private, default), or 'workspace'.",
        },
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
  { name: "kleap", version: "1.0.0" },
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
