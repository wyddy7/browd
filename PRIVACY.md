# Privacy

Browd is designed to run locally as a browser extension using model providers configured by the user.

User-provided API keys are stored in browser extension storage. Browser automation, chat history, provider settings, and Speech-to-Text inputs may be processed locally by the extension and sent to the model provider selected by the user for the requested task.

The project should not add analytics, telemetry, or remote logging without an explicit product decision and an update to this file.

Do not commit API keys, tokens, private prompts, audio recordings, or browser session data.
