# Browser AI Connector

Browser AI Connector is a Manifest V3 Chrome extension for using an OpenAI API key from page `fetch` calls without placing the registered key in page JavaScript. This initial slice supports `https://api.openai.com/v1/*` requests from exact page origins.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository directory.
3. Pin Browser AI Connector if desired, then click its toolbar action to open credential management.
4. Add the page's exact origin and its OpenAI API key. Reload the application tab after installing the extension.

Use HTTPS page origins. HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]` during local development. Keys are stored in `chrome.storage.local`, are not read back into the management page, and are never sent through page messaging or synchronized storage. Removing a key leaves its assignment in place and blocks matching requests; removing the assignment restores native networking.

Unmatched requests keep the page's native network path. A matching request replaces its authorization with the assigned key. The model identifier and request body are not modified. Response bodies stream to the page, and abort/cancel signals are forwarded upstream.

## Verify

```sh
npm test
```

The browser test uses a local mock OpenAI endpoint and a disposable browser profile. It needs Node.js 20+, Chrome or Chromium, and OpenSSL. The runner prefers an installed Chromium or cached Playwright Chromium; set `CHROME_EXECUTABLE_PATH` to select another browser executable. Some branded Chrome builds restrict loading unpacked extensions from command-line automation, so use an unbranded Chromium for the automated test when needed.

To exercise the same relay from a reachable JupyterLite deployment, set `JUPYTERLITE_URL` to its page URL. The test still sends OpenAI traffic only to its local mock; loading the application page itself requires network access.
