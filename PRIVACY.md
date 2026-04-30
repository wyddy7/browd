# Privacy

Browd is a Chromium browser extension for local AI browser automation.

## What Browd stores

- Provider configuration and user-provided API keys in browser extension storage.
- Chat history, task state, and extension settings in browser extension storage.
- Speech-to-Text audio only for the active transcription request flow.

## What Browd sends

- Browser automation context, prompts, chat messages, and optional Speech-to-Text audio may be sent to the model provider selected by the user for that request.
- Browd does not send built-in product analytics, telemetry, or remote logging data.

## What Browd does not include

- No built-in usage analytics.
- No session replay or screen recording pipeline.
- No remote error reporting service by default.

## Notes

- If remote analytics or telemetry is ever added in the future, this file must be updated first.
- Do not commit API keys, tokens, private prompts, audio recordings, or browser session data.
