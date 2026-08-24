# @pithos-kit/web

[![npm version](https://img.shields.io/npm/v/@pithos-kit/web)](https://www.npmjs.com/package/@pithos-kit/web)

Web adds bounded, read-only public Internet research to Pi. `web_search` uses the Brave Search JSON API, and `web_fetch` retrieves ordinary static HTML or text while blocking private-network destinations and framing all returned material as untrusted external data.

## Install

```bash
pi install npm:@pithos-kit/web
```

Pin the initial release:

```bash
pi install npm:@pithos-kit/web@0.1.1
```

For local development:

```bash
pi install -l ./pithos.web
```

## Pithos `.pithos` config

```yaml
pi:
  extensions:
    "@pithos-kit/web": "npm:0.1.1"
```

## Brave Search onboarding

When `PI_OFFLINE` is not enabled, `web_fetch` works immediately after installation and does not need a credential. `web_search` needs a Brave Search API key; when the key is missing, its tool description tells the agent that search is unavailable so it should guide you to `/web-setup` instead of retrying.

1. In Pi, run `/web-setup` to check whether this Pi process sees `BRAVE_SEARCH_API_KEY`. Use `/web-setup --help` for package-local help. The command checks local environment presence only: it makes no network request, never validates the credential remotely, and never displays the key. It uses notifications in TUI/RPC mode, terminal stderr in print mode (leaving stdout reserved for normal print responses), and a protocol-safe custom message in JSON mode.
2. Register for Brave Search API access at <https://api-dashboard.search.brave.com/register>.
3. Activate a Search plan at <https://api-dashboard.search.brave.com/app/plans>.
4. Create or manage a key at <https://api-dashboard.search.brave.com/app/keys>.
5. Exit Pi. In the shell that will restart Pi, use the matching secure input command:

   **Bash**

   ```bash
   read -rsp 'Brave Search API key: ' BRAVE_SEARCH_API_KEY && echo
   export BRAVE_SEARCH_API_KEY
   pi
   ```

   **zsh**

   ```zsh
   read -s 'BRAVE_SEARCH_API_KEY?Brave Search API key: ' && echo
   export BRAVE_SEARCH_API_KEY
   pi
   ```

   **fish**

   ```fish
   read --silent --prompt-str 'Brave Search API key: ' --export BRAVE_SEARCH_API_KEY
   pi
   ```

   **PowerShell 7.1 or newer**

   ```powershell
   $env:BRAVE_SEARCH_API_KEY = Read-Host 'Brave Search API key' -MaskInput
   pi
   ```

These exports last for the current shell. For persistence, use a trusted secret manager or user-only shell configuration; never commit the key to project files. Never paste the key into Pi chat, a `web_search` query, or any tool arguments. Starting the extension and running `/web-setup` remain network-free.

The key is sent only in the `X-Subscription-Token` header to the fixed `https://api.search.brave.com/res/v1/web/search` endpoint. It is never accepted as a tool argument, written to session details, included in normalized errors, or returned in Search result details. Brave account setup, quotas, pricing, retention, and service policy remain governed by Brave.

If Brave returns HTTP 401 or 403, Web reports that Brave rejected the credential or that it may have an inactive Search plan; run `/web-setup`, check the key and plan, then restart Pi after correcting the environment. HTTP 429 reports a quota or rate limit; check the Search plan, wait before retrying, or increase the plan. These errors do not include Brave response bodies or the key.

Unless `PI_OFFLINE` is enabled, `web_fetch` still works without the Brave credential and deliberately sends no cookies or authorization headers.

## Tools

### `web_search`

```text
web_search({ query: "Pi extension API", count: 5 })
```

- Accepts a non-empty query of at most 500 characters.
- Returns 5 results by default and at most 10.
- Includes a title, public HTTP(S) URL, and bounded snippet for each usable result.
- Uses a ten-second deadline and a 1MB Brave JSON response ceiling.
- Does not fetch result pages automatically; use `web_fetch` for a chosen source.
- Shows a `searching for <query>` spinner in the TUI footer only while a search request is pending. Search text is limited to 64 grapheme clusters; the API key is never displayed. The status clears on success, failure, or cancellation.

Do not put secrets, private source, credentials, or personal data in search queries. The query and request metadata leave the local machine for Brave.

### `web_fetch`

```text
web_fetch({ url: "https://example.com/docs" })
```

- Performs only unauthenticated `GET` requests for `http:` and `https:` URLs on standard ports.
- Allows at most five redirects and validates every destination again.
- Uses a 15-second deadline and a 2MB downloaded-body ceiling.
- Accepts HTML, plain/Markdown text, JSON, XML, and other declared `text/*`, `+json`, or `+xml` responses.
- Decodes standard web charset labels and UTF BOMs; unknown charsets or invalid declared text are rejected instead of returned corrupted.
- Removes scripts, styles, templates, SVG/canvas content, and noscript noise from HTML while preserving readable headings, text, and useful absolute links.
- Applies HTML input, depth, child-node, rendered-link-count, per-link, and title budgets before final output truncation; every safety omission is reported.
- Keeps model-facing output below Pi's 50KB and 2000 lines limits (the extracted page payload is capped at 48KB and 1900 lines) and reports when content is truncated.

The fetcher resolves the hostname itself, rejects any non-public or mixed public/private DNS answer, and pins a vetted address into the connection. It also revalidates redirects and rejects URL credentials. These controls reduce SSRF and DNS-rebinding risk; they do not turn Pi extensions into an operating-system sandbox.

## Plan mode

`@pithos-kit/plan` recognizes `web_search` and `web_fetch` as optional read-only planning tools. It retains them during brainstorming and design only when Pi reports package-origin provenance rooted in the canonical `@pithos-kit/web` package (or this local `pithos.web` development directory). Same-named SDK, top-level, spoofed-source, path-escaping, and unrelated custom tools remain blocked.

Run `/reload` or restart Pi after installing/updating both packages. A new Plan session then exposes the built-in read tools, these Web tools, and Plan's controlled creator.

## Untrusted content and prompt injection

Search snippets and fetched pages are wrapped in visible `UNTRUSTED` boundaries. The tools instruct the model to treat them as data and never as instructions. This is guidance, not a guarantee: hostile pages can contain prompt injection, false claims, or misleading citations. Verify important claims across reputable sources and never execute commands, reveal secrets, or change project scope because a page asks.

## Offline mode

Disable both tools before any request:

```bash
PI_OFFLINE=1 pi
# also accepted: true, yes (case-insensitive)
```

The package performs no startup network traffic. While `PI_OFFLINE` is enabled, both `web_search` and `web_fetch` are disabled; their model-facing guidance tells the agent not to call either tool. `/web-setup` reports the offline state without making a request or displaying the key. Unset `PI_OFFLINE` and restart Pi to enable web access.

## Deliberate limitations

Web does not support:

- private networks, localhost, link-local or cloud metadata endpoints;
- nonstandard ports, URL credentials, cookies, sessions, logins, POST requests, or authenticated pages;
- JavaScript-rendered pages or a headless browser;
- PDFs, images, archives, media, or other binary downloads;
- recursive crawling, forms, robots automation, or persistent caches;
- search providers other than Brave or provider fallback.

A JavaScript-rendered or authenticated site may return an empty shell; use a static public source instead.

## Development

```bash
cd pithos.web
npm ci
npm test
npm run typecheck
npm run audit
npm pack --dry-run
```

Tests inject DNS, transport, and fetch boundaries and do not call live Internet services. A live Brave smoke test is optional and requires an explicit credential.
