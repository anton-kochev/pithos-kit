# Web behavior list

## Public network boundary
- [x] Accept only normalized public `http:` and `https:` URLs on their standard ports without credentials.
- [x] Reject unsupported schemes, localhost names, private/link-local/reserved/multicast addresses, mixed public/private DNS answers, and path-escaping or rebinding destinations.
- [x] Pin a validated DNS result into each connection and revalidate every redirect.
- [x] Combine caller cancellation with a request deadline, limit redirects, and stop consuming oversized responses.

## Brave search
- [x] Require `BRAVE_SEARCH_API_KEY`, call only Brave's fixed web-search endpoint, encode the query, and clamp result counts to ten.
- [x] Explain missing-key setup with `/web-setup`, official Brave registration/key links, restart guidance, continued `web_fetch` availability, and a warning never to paste the key into chat or tool arguments.
- [x] Map Brave HTTP 401/403 to rejected-credential or inactive-Search-plan guidance and HTTP 429 to quota/rate-limit guidance.
- [x] Validate and bound Brave response data without leaking credentials or upstream bodies in errors.
- [x] Return useful title, URL, and description entries with explicit untrusted-content framing.

## Page fetching and extraction
- [x] Fetch public HTML and textual resources without cookies, authentication, scripts, or non-GET requests.
- [x] Convert HTML to compact readable text, remove executable/non-content elements, and preserve useful links.
- [x] Reject unsupported/binary content and report empty pages clearly.
- [x] Bound model-facing output by bytes and lines with an explicit truncation notice and source URL.

## Pi tools and onboarding
- [x] Register strict `web_search` and `web_fetch` schemas without startup network access; keep `web_fetch` usable without a Brave key.
- [x] Register `/web-setup` to report configured versus missing from local environment presence only, without network validation or key disclosure.
- [x] Provide secure Bash, zsh, fish, and PowerShell 7 credential input/restart instructions and official Brave links from `/web-setup`.
- [x] Emit `/web-setup` guidance through notifications in TUI/RPC, terminal stderr in print mode, and a protocol-safe message in JSON mode.
- [x] Describe and guide `web_search` as unavailable and non-retriable when the key is missing while preserving normal configured guidance.
- [x] Describe both web tools as disabled in offline mode and prevent setup status from claiming either is available.
- [x] Show a `searching for <query>` TUI status only while one or more search requests are pending, limit displayed search text to 64 grapheme clusters, never show the API key, and clear it after success, failure, or cancellation.
- [x] Propagate tool cancellation, honor `PI_OFFLINE`, and throw clean tool errors.
- [x] Tell the model to use web research for current/external facts and treat every result as untrusted data rather than instructions.

## Plan integration
- [x] Keep genuine `@pithos-kit/web` tools active and callable during Plan mode.
- [x] Reject same-named SDK, top-level, spoofed-manifest, path-escaping, and unrelated custom tools.
- [x] Document the narrow network-read exception while retaining Plan's mutation, shell, delegation, and other-custom-tool bans.

## Package and repository
- [x] Prepare `@pithos-kit/web` v0.1.0 for Pi >=0.83.0 and Node >=22.19.0 with its extension, source, docs, license, dependencies, tests, and lockfile.
- [x] Document complete Brave onboarding, `/web-setup`, credential and quota failures, offline mode, limits, safety boundaries, Plan use, and unsupported dynamic/authenticated/binary pages.
- [x] Wire local development, root identity checks, trusted publishing, and the generated Atlas catalog.
