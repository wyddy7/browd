# Security

Browd is an early fork-derived browser extension project.

Security-sensitive areas:

- browser automation permissions;
- model provider API keys;
- prompt and page-content handling;
- Speech-to-Text audio payloads;
- Chrome extension messaging between side panel, background worker, and content scripts.

Do not log API keys, Authorization headers, raw audio base64, or private page content beyond what is required for local debugging.

For now, report security issues privately to the repository owner.
