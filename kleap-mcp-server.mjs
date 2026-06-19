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
      "Resolve a website the user names by its ADDRESS — a custom domain (\"serrureriesk.ch\"), a kleap.io URL (\"mysite.kleap.io\"), or a bare slug (\"mysite\") — to one of your apps in ONE call. Use this FIRST whenever the user refers to a site by its domain/URL instead of an app id, then pass the returned app_id to get_app / modify_app / publish_app. Do not list every app and scan. Returns NOT_FOUND if no owned app matches (the site may not be on this account or not connected yet) — then fall back to list_apps.",
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
      "Get one Kleap app's metadata: status, slug, production_url, published state. Use this for general app info at any time. To specifically confirm a deploy/publish, use get_publish_status.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}`),
  },
  {
    name: "list_app_files",
    description:
      "List the source file PATHS of a Kleap app (names only — no contents). READ-ONLY: there is no tool to read a file's contents or to write/edit/delete files. Make all changes via modify_app (Kleap's AI edits the code).",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("GET", `/apps/${app_id}/files`),
  },
  {
    name: "create_app",
    description:
      "Create a new Kleap website (an Astro site) from a natural-language prompt. Returns app_id + task_id immediately; poll check_task until status='completed' (~5-15 min). The site auto-builds and goes LIVE on completion — no separate publish needed for the first version.",
    inputSchema: obj(
      {
        prompt: str("What the website should be."),
        visibility: str("'public' (discoverable) or 'personal' (private)."),
        webhook_url: str(
          "Optional HTTPS URL that Kleap POSTs when the build finishes — use it for a hands-off flow instead of polling check_task.",
        ),
      },
      ["prompt"],
    ),
    handler: ({ prompt, visibility, webhook_url }) =>
      api("POST", "/apps", {
        prompt,
        visibility: visibility || "personal",
        ...(webhook_url ? { webhook_url } : {}),
      }),
  },
  {
    name: "modify_app",
    description:
      "Ask a Kleap app's AI to change it — describe the OUTCOME you want (edit copy, add a section or page, fix a bug); the AI writes the files (you cannot write files yourself). Returns a task — poll check_task. For MANY similar pages (programmatic SEO), ask in ONE call for a single dynamic Astro route + a data file, NOT one page per call.",
    inputSchema: obj(
      {
        app_id: num("The app id."),
        message: str("The change to make."),
        webhook_url: str(
          "Optional HTTPS URL that Kleap POSTs when the edit finishes — for a hands-off flow instead of polling check_task.",
        ),
      },
      ["app_id", "message"],
    ),
    handler: ({ app_id, message, webhook_url }) =>
      api("POST", `/apps/${app_id}/messages`, {
        message,
        ...(webhook_url ? { webhook_url } : {}),
      }),
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
      "Check an async create/modify task. By default it LONG-POLLS: the call holds for up to 'wait' seconds and returns the moment the task finishes — so you wait efficiently instead of hammering this every few seconds through a 5-15 min build. Just call it again if status is still queued/processing. status is one of: queued, processing, completed, failed. On 'completed' the change is built and LIVE (app_id + production_url available). On 'failed', error.code is TASK_TIMEOUT or STALE_TASK (the build STALLED — transient — call retry_task, which returns a NEW task_id to poll) or TASK_FAILED (generation failed — read error.message; retry_task once, and if it repeats, stop and tell the user). (Out-of-credits is not a task failure — create_app/modify_app reject up front with 402 INSUFFICIENT_CREDITS.)",
    inputSchema: obj(
      {
        task_id: str("The task id."),
        wait: num(
          "Seconds to long-poll, 0-50 (default 45). The call returns early the instant the task reaches completed/failed. Use 0 for an immediate snapshot.",
        ),
      },
      ["task_id"],
    ),
    handler: ({ task_id, wait }) => {
      const w = wait == null ? 45 : Math.min(Math.max(Number(wait) || 0, 0), 50);
      return api(
        "GET",
        `/tasks/${encodeURIComponent(task_id)}?wait=${w}`,
        undefined,
        { timeoutMs: (w + 15) * 1000 },
      );
    },
  },
  {
    name: "retry_task",
    description:
      "Resume a failed/stalled create/modify task from where it stopped (partial files preserved). Use when check_task reports 'failed', instead of starting a brand-new create_app. Returns a NEW task_id — poll check_task on that NEW id (not the original). Budget: retry TASK_TIMEOUT/STALE_TASK up to TWICE; retry TASK_FAILED only ONCE; then stop and tell the user. NEVER retry a non-transient error (402 INSUFFICIENT_CREDITS, a rejected prompt) — it just fails again.",
    inputSchema: obj({ task_id: str("The failed task id to resume.") }, [
      "task_id",
    ]),
    handler: ({ task_id }) => api("POST", `/tasks/${task_id}/retry`, {}),
  },
  {
    name: "publish_app",
    description:
      "Force a (re)publish of an app to its live URL, with the VERIFIED-LIVE guarantee: only reported live once provably serving (else 'not confirmed live' — never a false positive). Usually NOT needed — create_app/modify_app already deploy on completion. Returns a deploy handle; poll get_publish_status. If it reports not-confirmed-live, keep polling get_publish_status — do not loop publish_app.",
    inputSchema: obj({ app_id: num("The app id.") }, ["app_id"]),
    handler: ({ app_id }) => api("POST", `/apps/${app_id}/publish`, {}),
  },
  {
    name: "get_publish_status",
    description:
      "Confirm whether an app is actually published and live (production_url + published state) — use this to answer \"is it live yet?\", typically after publish_app. For general app metadata use get_app instead.",
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
      "Connect a domain the user ALREADY OWNS to a live Kleap app (sets up routing + automatic TLS). The app must be live first — a completed create_app/modify_app already counts as published, so you do NOT need to call publish_app first. The response includes a `dns_config` object with the exact A records the user must set at their registrar (+ propagation time) — relay those to the user. Does not buy anything.",
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

const INSTRUCTIONS = `Kleap builds and HOSTS real websites (Astro). You drive Kleap by INSTRUCTING ITS AI in plain language — you do NOT write or edit files yourself. There is no file-write tool, by design: Kleap's AI owns the codebase so it can build, fix, type-check and deploy with a verified-live guarantee. (list_app_files is READ-ONLY — it lists file names only; there is no read-content or write-file tool.)

THE LOOP
1. Find the site. If the user names it by address ("serrureriesk.ch", "mysite.kleap.io"), call find_app FIRST. If find_app returns NOT_FOUND, the site isn't on this account or isn't connected yet — fall back to list_apps (supports ?q=) or ask the user. Otherwise use list_apps.
2. Build or change it:
   - New site: create_app(prompt). Its response includes app_id AND a task_id right away.
   - Change an existing site: modify_app(app_id, message) — describe the OUTCOME; the AI writes every file.
   Both return a task_id. Call check_task(task_id) — it LONG-POLLS by default (holds up to 50s, default 45, and returns the instant the build finishes), so just call it again while status is queued/processing. A full build is ~5-15 min, NOT instant, so calling check_task ~10-20 times in a row through one build is EXPECTED — that is normal waiting, not a "loop" (the loop warnings below are only about retrying failed tasks). For a fully hands-off flow, create_app/modify_app also accept a webhook_url that is POSTed when the task finishes.
3. When status="completed", the change is already BUILT AND LIVE at the production URL — create_app and modify_app auto-deploy. (publish_app + get_publish_status only force/verify a re-publish; you normally don't need them after a build.) connect_domain attaches a domain the user already owns (the app must be live first).

ON FAILURE (check_task status="failed"): error.code is one of:
  - TASK_TIMEOUT / STALE_TASK → the build STALLED (transient). Call retry_task(task_id); it returns a NEW task_id — poll check_task on THAT id. Retry up to twice.
  - TASK_FAILED → generation failed. Read error.message; retry_task once. If it repeats, STOP and tell the user. Do NOT loop.

ERRORS BEFORE A TASK STARTS (HTTP errors thrown by create_app/modify_app, with an error.code): 402 INSUFFICIENT_CREDITS (check get_credits and ask the user to top up — do NOT retry), 400 VALIDATION_ERROR (fix the input), 401 UNAUTHORIZED (bad/expired key), 429 RATE_LIMITED (back off, honor Retry-After), 404 NOT_FOUND (wrong app_id — use find_app).

Send ONE coherent change per modify_app call.

MANY SIMILAR PAGES / PROGRAMMATIC SEO — read this before you start:
Do NOT create hundreds of pages with hundreds of calls — it stalls and is the wrong approach. In ONE modify_app call, ask the AI to add a DYNAMIC ROUTE + a DATA FILE. Example:
  "Add a dynamic Astro route at src/pages/[service]/[city].astro driven by a data file src/data/locations.json containing these entries: <paste your full list>. Each page renders the service + city, localized intro, an FAQ and a contact CTA. Also add a /services index page linking to all of them."
One instruction generates ALL the pages from the data, scales to thousands, deploys once. Up to a few hundred entries inline in one call is fine; for thousands, add them in batches via follow-up modify_app calls. This is THE correct way to do programmatic SEO on Kleap.

rename_app changes only the display name — the live URL never changes. There is no delete tool, by design.

KEYS & SCOPES: this server can't manage API keys. Users create and SCOPE keys in Kleap (Settings -> MCP / API access): pick Read-only (inspect sites, no changes), Build, or Full. So if a user wants a read-only agent, tell them to generate a Read-only key there. Buying domains is never included by default.`;

const server = new Server(
  { name: "kleap", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
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
