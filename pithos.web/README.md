# @pithos-kit/web

[![npm version](https://img.shields.io/npm/v/@pithos-kit/web)](https://www.npmjs.com/package/@pithos-kit/web)

Web adds two tools for public Internet research in Pi: `web_search` finds public pages, and `web_fetch` reads public static HTML or text. Under Pithos, Brave and authenticated Keenable run on the host so Pi never receives their keys. Standalone Pi can use Brave directly. Both tools mark external content as untrusted.

## Install

Requires Pi **1.0.0 or later**.

```bash
pi install npm:@pithos-kit/web
```

Host-backed search requires Web `0.4.0` or later and a Pithos launcher with host-search support. Web `0.3.0` does not support the host broker. If `.pithos` still pins `0.3.0`, update it as shown below. Don't export a provider key into Pi to work around a version mismatch.

To try an unreleased build, use a test project that contains the matching `pithos.web` source directory. From the project root:

```bash
(cd pithos.web && npm ci --omit=dev)
pi install -l ./pithos.web
```

In Pithos, remove the published Web pin from `pi.extensions` first, then install the local build in the container with `pithos run -- pi install -l ./pithos.web`. Don't load the local and published copies together.

## Pithos: host-owned search

1. Pin the broker-aware Web release under `pi.extensions` in `.pithos`:

   ```yaml
   pi:
     extensions:
       "@pithos-kit/web": "npm:0.4.0"
   ```

   Use one Web installation; you don't need a separate Pi extension for Keenable.
2. On the **host**, create `$HOME/.config/pithos/web/` (mode `0700`) and its `.env` file (mode `0600`). Keep both outside every Pithos bind mount. Follow [Pithos host setup](https://github.com/anton-kochev/pithos#private-web-search) for the commands. Open the file in a host editor, not inside Pi.
3. Set `PITHOS_WEB_SEARCH_PROVIDER` to `brave` or `keenable` and set the matching key on a separate line. For example:

   ```dotenv
   PITHOS_WEB_SEARCH_PROVIDER=keenable
   KEENABLE_API_KEY=replace-with-your-keenable-key
   ```

   For Brave use `BRAVE_SEARCH_API_KEY`. Use plain literal values, not shell exports. Move keys out of old project `.env` files and rotate any that Pi could previously read.
4. Restart Pithos and run `/web-setup` in Pi. This checks whether Pi can reach and authenticate to the host broker. It doesn't send a search or validate the upstream key or quota. `web_search` uses the host's choice automatically on normal and managed Pi launches; no Docker flags or per-session exports are needed.

The host sends the query only to the selected provider. Missing or rejected credentials don't trigger a switch or keyless Keenable. Pi can spend the session's search quota, but the provider key is never part of the tool contract. `web_fetch` works independently and never uses either provider.

## Standalone Pi: Brave Search

Outside Pithos, `web_search` uses Brave directly. Its key is visible to the Pi process and its shell; this is not the host-isolated setup above. When the key is missing, the tool points to `/web-setup` rather than retrying. `web_fetch` still works without a credential unless offline mode is on.

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

These exports last for the current shell. For persistence, use a trusted secret manager or user-only shell configuration; never commit the key to project files. Never paste the key into Pi chat, a `web_search` query, or any tool arguments. Starting the extension and running `/web-setup` in standalone Pi remain network-free.

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
- Bounds provider requests to ten seconds and provider JSON to 1 MiB. In Pithos the client also caps broker replies at 64 KiB and waits up to 15 seconds for a search reply or two seconds for readiness.
- Does not fetch result pages automatically. The host rejects URL-only queries when using Keenable; use `web_fetch` for a specific public URL.
- Shows a `searching for <query>` spinner in the TUI footer only while a search request is pending. Search text is limited to 64 grapheme clusters; the API key is never displayed. The status clears on success, failure, or cancellation.

Do not put secrets, private source, credentials, or personal data in search queries. The query and request metadata go to the selected provider. Provider terms and data policies still apply; see [Keenable's data policy](https://docs.keenable.ai/data-privacy), for example.

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

Run `PI_OFFLINE=1 pithos` on the host, or `PI_OFFLINE=1 pi` for standalone Pi. `true` and `yes` also work (case-insensitive). On an ordinary Pithos launch, `pithos --pi --offline` also works; Pithos does not issue a search token.

The extension makes no startup requests. In offline mode, both `web_search` and `web_fetch` are disabled. `/web-setup` reports the offline state without connecting to the broker. Restart without offline mode to enable web access.

## Deliberate limitations

Web does not support:

- private networks, localhost, link-local or cloud metadata endpoints;
- `web_fetch` on nonstandard ports, with URL credentials, cookies, sessions, logins, POST requests, or authenticated pages;
- JavaScript-rendered pages or a headless browser;
- PDFs, images, archives, media, or other binary downloads;
- recursive crawling, forms, robots automation, or persistent caches;
- automatic retries or provider fallback, keyless Keenable, or Keenable fetch.

A JavaScript-rendered or authenticated site may return an empty shell; use a static public source instead.

## Add a search provider

Add the adapter to the **Pithos launcher** repository, not to this Pi extension. Pi sends `query` and optional `count`; the host chooses the destination and returns ranked `title`, `url`, and `description` values. Don't add a Pi tool or a caller-controlled endpoint, header, or credential name.

Keenable is a worked example in [`src/web_search/provider.rs`](https://github.com/anton-kochev/pithos/blob/main/src/web_search/provider.rs):

1. Implement `Adapter`. `id()` is the host selector (`keenable`), `key_name()` names the host-only dotenv entry (`KEENABLE_API_KEY`), and `key_header()` names the upstream header (`X-API-Key`). `SearchService` attaches only the selected adapter's key.
2. In `request()`, build the fixed HTTPS request. Keenable uses `POST https://api.keenable.ai/v1/search` with `query` and `max_results` in JSON. It asks for bounded snippets and rejects URL-only queries before sending them because Keenable can treat a URL as a fetch. See the [Keenable Search API](https://docs.keenable.ai/api-reference/search).
3. In `map_response()`, map `results[]` with `result_list(body, "snippet")`. For example, `{ "title": "Example", "url": "https://example.com/", "snippet": "An excerpt" }` maps to `title`, `url`, and `description: "An excerpt"`. Ignore Keenable's deprecated `description` field. Reuse `SearchService` for TLS, timeouts, limits, redirect refusal, result cleanup, and safe error codes. Don't return upstream error bodies, which may contain request data.
4. Add the adapter to the host `ADAPTERS` list. The user selects its `id()` in the host `.env` with `PITHOS_WEB_SEARCH_PROVIDER`, sets the entry named by `key_name()`, and restarts Pithos. No changes to this Web extension, its tool schema, or `web_fetch` are needed.
5. In the launcher repo, add fixtures in [`src/web_search/provider/tests.rs`](https://github.com/anton-kochev/pithos/blob/main/src/web_search/provider/tests.rs). Use `SearchService::search_using` to capture the outgoing request and return a fixture instead of calling a live API. Assert the method, fixed endpoint, and selected synthetic key. Check normalized results, missing excerpts, malformed replies, rate and auth errors, and no redirect or fallback. Run `cargo test --locked --lib web_search::provider::tests` from that repo and `npm test` in `pithos.web` to check the client still exposes the same two tools and renders results without depending on a particular provider.

For a third-provider example that never contacts the network, see `fixture_only_adapter_reuses_the_shared_search_contract` in the same Rust test file. Adding a provider requires rebuilding the host binary, not exposing another credential to Pi.

## Development

```bash
cd pithos.web
npm ci
npm test
npm run typecheck
npm run audit
npm pack --dry-run
```

Tests use synthetic broker replies and inject DNS, transport, and fetch boundaries. They don't read the host `.env` or call live search providers.
