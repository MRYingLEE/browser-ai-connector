# Browser AI Connector

Browser AI Connector is a Manifest V3 Chrome extension for using OpenAI, Anthropic, and Google AI credentials from page `fetch` calls without placing the registered key in page JavaScript. It supports `https://api.openai.com/v1/*`, Anthropic `POST https://api.anthropic.com/v1/messages`, and Google AI `POST` requests to the `v1` and `v1beta` `models/{model}:generateContent` and `:streamGenerateContent` endpoints on `generativelanguage.googleapis.com`. Google AI credentials are sent in the `x-goog-api-key` header, not the request URL.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository directory.
3. Pin Browser AI Connector if desired, then click its toolbar action to open credential management.
4. Choose a provider, then add the page's exact origin and its API key. Reload the application tab after installing the extension.

Use HTTPS page origins. HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]` during local development. Each provider has a separate credential assignment for each page origin. Keys are stored in `chrome.storage.local`, are not read back into the management page, and are never sent through page messaging or synchronized storage. Removing a key leaves its assignment in place and blocks matching requests; removing the assignment restores native networking.

Unmatched requests keep the page's native network path. A matching request replaces the provider's credential header with the assigned key. The Anthropic `anthropic-version` header, model identifier, and request body are preserved. Response bodies stream to the page, and abort/cancel signals are forwarded upstream.

## Dedicated Workers

To route calls from a dedicated Web Worker, create it with `BrowserAIConnector.createWorker(workerUrl, options)` instead of `new Worker(workerUrl, options)`. The factory installs a worker-local `fetch` relay, so existing GenAI call sites inside the worker stay unchanged. The worker entry URL must use the page's exact origin. Standard worker options, including `{ type: 'module' }`, are passed through.

The worker bootstrap uses a Blob URL, so the page's Content Security Policy must allow `blob:` in `worker-src`. Workers created without this integration, Shared Workers, and Service Workers are not intercepted. Integrated worker requests use the same page-origin/provider assignments and key privacy rules as page requests; unmatched requests use the worker's native fetch. Response streaming and cancellation are forwarded through the extension.

## Verify

```sh
npm test
```

The browser test uses local mock OpenAI, Anthropic, and Google AI endpoints and a disposable browser profile. It needs Node.js 20+, Chrome or Chromium, and OpenSSL. The runner prefers an installed Chromium or cached Playwright Chromium; set `CHROME_EXECUTABLE_PATH` to select another browser executable. Some branded Chrome builds restrict loading unpacked extensions from command-line automation, so use an unbranded Chromium for the automated test when needed.

To exercise the same relay from a reachable JupyterLite deployment, set `JUPYTERLITE_URL` to its page URL. The test still sends OpenAI, Anthropic, and Google AI traffic only to local mocks; loading the application page itself requires network access.
