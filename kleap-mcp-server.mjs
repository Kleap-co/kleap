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

/** Thin REST caller — one place for auth, JSON, and error normalization. */
async function api(method, path, body) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
    throw new Error(`HTTP ${res.status} ${method} ${path} — ${msg.slice(0, 500)}`);
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
      "List the Kleap apps (websites) owned by the authenticated account.",
    inputSchema: obj({
      limit: num("Max apps to return (default 20)."),
      offset: num("Pagination offset (default 0)."),
    }),
    handler: ({ limit, offset } = {}) => {
      const q = new URLSearchParams();
      if (limit != null) q.set("limit", String(limit));
      if (offset != null) q.set("offset", String(offset));
      const qs = q.toString();
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
