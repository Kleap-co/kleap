# Changelog

All notable changes to the Kleap MCP server / CLI.

## [1.1.1] — 2026-06-24
- Docs: install as `@eliottd/kleap` (npm blocked the unscoped name). No code change.

## [1.1.0] — 2026-06-23
- `kleap auth login` — sign in with your browser (OAuth, PKCE, RFC 8252 loopback),
  no API key to copy. The token is saved to `~/.kleap/config.json` and used
  automatically by `npx kleap`; `kleap auth logout` / `kleap auth status` too.
- `KLEAP_API_KEY` still works and takes precedence (nothing breaks).

## [1.0.8] — 2026-06-20
- Server `instructions` (the agent "skill"): how Kleap works, the find→build→poll→publish
  loop, the programmatic-SEO pattern (one dynamic route + data file, not N page calls),
  the error-code vocabulary, and key scoping.
- `check_task` long-polls (`wait`, default 45s) so agents don't hammer a multi-minute build;
  `create_app`/`modify_app` accept a `webhook_url` for fully hands-off flows.
- `find_app` (resolve a domain / URL / slug → app_id in one call) and `rename_app`
  (display name only, URL unchanged). 15 tools total.
- Hardened `api()`: timeout + bounded retry + 429/5xx backoff + clean errors.
- Fixes: server handshake version aligned to package version; honest build-time wording;
  tool count corrected to 15 everywhere.

## [1.0.0] — 2026-06-18
- Initial public release: MCP server + CLI wrapping the Kleap `/api/v1` REST API.
- create / modify / publish with the verified-live guarantee; domains; credits.
