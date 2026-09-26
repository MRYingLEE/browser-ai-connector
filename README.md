# Browser AI Connector

Browser AI Connector is a Chrome extension that keeps GenAI provider credentials outside web-page and worker code while letting those contexts make authenticated requests. Its purpose is to help prevent real credentials from being exposed by GenAI-generated code: store credentials in the extension and use placeholders in application code wherever a client requires a credential. The extension adds the configured credential only to matching requests. It does not scan or remove secrets embedded elsewhere in generated code or request bodies, so never put real credentials in page or worker code.

The Manifest V3 extension supports OpenAI, Anthropic, Google AI, Agnes, Azure OpenAI, and other API-key-based provider credentials from page `fetch` calls without placing the registered key in page JavaScript. It supports OpenAI-compatible `POST` requests to `/v1/chat/completions`, `/v1/completions`, and `/v1/responses`; Anthropic `POST https://api.anthropic.com/v1/messages`; Google AI `generateContent` and `streamGenerateContent`; Agnes at `https://apihub.agnes-ai.com/v1` using the OpenAI-compatible API; Azure classic deployment and `/openai/v1` chat/completions APIs; and custom Vercel AI SDK provider endpoints configured by API base URL. Azure accepts API keys or Microsoft Entra application credentials using the client-credentials flow. Google AI credentials use `x-goog-api-key`; Azure API keys use `api-key`.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository directory.
3. Pin Browser AI Connector if desired, then click its toolbar action to open credential management.
4. Choose a provider, then add the page's exact origin and provider credentials. Keep real keys and secrets here, not in GenAI-generated application code; use a placeholder in code when the client requires one. Azure also requires the resource URL; Entra mode requires tenant ID, application ID, and client secret value. The settings form includes provider-specific setup guidance. Reload the application tab after installing, reloading, or updating the extension so it receives a fresh content-script context.

Use HTTPS page origins. HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]` during local development. Each provider has a separate credential assignment for each page origin. Keys are stored in `chrome.storage.local`, are not read back into the management page, and are never sent through page messaging or synchronized storage. This keeps the registered key out of the page's JavaScript sandbox. Removing a key leaves its assignment in place and blocks matching requests; removing the assignment restores native networking.

Only configured matching requests are mediated; unmatched requests keep the page's native network path. A matching request replaces the configured credential field (a header or, for custom providers, a query parameter) with the assigned credential, so generated code can use a placeholder instead of a real secret. The extension does not redact secrets from request bodies or other application data. The Anthropic `anthropic-version` header, model identifier, and request body are preserved. Response bodies stream to the page, and abort/cancel signals are forwarded upstream.

Agnes uses `https://apihub.agnes-ai.com/v1`, an Agnes API key, and model `agnes-2.5-flash`; send a placeholder bearer key in application code. Azure assignments use a resource URL such as `https://my-resource.openai.azure.com`. The extension preserves deployment paths and `api-version` query values while routing to that resource. Entra uses `https://cognitiveservices.azure.com/.default` and requires the registered app to have Azure OpenAI data-plane access, such as the Cognitive Services OpenAI User role. Client secrets are stored in `chrome.storage.local`, not a protected vault; use them only where workstation storage is permitted by your organization. Access tokens stay in background-worker memory and are refreshed before expiry.

For other Vercel AI SDK providers, choose **Custom provider**, enter a name and the API base URL used by the application, and select bearer, custom-header, or query-parameter key placement. The provider's SDK package and native API format remain unchanged; the extension matches POST requests under that base URL and replaces the credential. Saving a custom provider asks Chrome for optional access to that host. This works with providers that accept a static API key in one of those formats; OAuth, request-signing schemes such as AWS SigV4, and provider-specific credential exchanges require dedicated support and are not translated by the generic option.

## Dedicated Workers

To route calls from a dedicated Web Worker without putting real provider credentials in worker code, create it with `BrowserAIConnector.createWorker(workerUrl, options)` instead of `new Worker(workerUrl, options)`. The factory installs a worker-local `fetch` relay, so existing GenAI call sites inside the worker can use placeholder credentials. The worker entry URL must use the page's exact origin. Standard worker options, including `{ type: 'module' }`, are passed through.

The worker bootstrap uses a Blob URL, so the page's Content Security Policy must allow `blob:` in `worker-src`. Workers created without this integration, Shared Workers, and Service Workers are not intercepted. Integrated worker requests use the same page-origin/provider assignments and key privacy rules as page requests; unmatched requests use the worker's native fetch. Response streaming and cancellation are forwarded through the extension.

## Verify

```sh
npm test
```

The browser test uses local mock provider endpoints and a disposable browser profile. It needs Node.js 20+, Chrome or Chromium, and OpenSSL. The Microsoft token endpoint is mocked through the browser debugging protocol; the test does not contact a real provider or Microsoft. The runner prefers an installed Chromium or cached Playwright Chromium; set `CHROME_EXECUTABLE_PATH` to select another browser executable. Some branded Chrome builds restrict loading unpacked extensions from command-line automation, so use an unbranded Chromium for the automated test when needed.

To exercise the same relay from a reachable JupyterLite deployment, set `JUPYTERLITE_URL` to its page URL. The test still sends provider traffic only to local mocks; loading the application page itself requires network access.
