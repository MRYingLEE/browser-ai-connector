import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chromeExecutable = process.env.CHROME_EXECUTABLE_PATH ?? await findChromeExecutable();

test('page fetch uses the credential assigned to its page origin without exposing it', async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'browser-ai-connector-'));
  const key = 'sk-test-registered-credential';
  const apiRequests = [];
  const workerScriptRequests = [];
  const browserConnections = [];
  let chrome;
  let siteServer;
  let otherSiteServer;
  let apiServer;

  t.after(async () => {
    for (const connection of browserConnections) connection.close();
    await stopBrowser(chrome);
    await Promise.all([closeServer(siteServer), closeServer(otherSiteServer), closeServer(apiServer)]);
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const keyPath = join(temporaryDirectory, 'localhost-key.pem');
  const certificatePath = join(temporaryDirectory, 'localhost-cert.pem');
  const certificateResult = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certificatePath,
    '-subj', '/CN=api.openai.com',
    '-addext', 'subjectAltName=DNS:api.openai.com,DNS:api.anthropic.com,DNS:generativelanguage.googleapis.com',
  ], { stdio: 'ignore' });
  assert.equal(certificateResult.status, 0, 'openssl must create the mock API certificate');

  const serveMockApplication = (request, response) => {
    if (request.url === '/dedicated-worker.js') {
      workerScriptRequests.push(request.url);
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`self.addEventListener('message', async ({ data }) => {
        try {
          const started = performance.now();
          const response = await fetch(data.url, {
            method: 'POST',
            headers: data.headers ?? { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
            body: JSON.stringify(data.payload),
          });
          if (data.terminateAfterResponse) {
            self.postMessage({ readyToTerminate: true });
            return;
          }
          const reader = response.body.getReader();
          const first = await reader.read();
          const firstChunk = new TextDecoder().decode(first.value);
          const elapsed = performance.now() - started;
          await reader.cancel();
          self.postMessage({
            status: response.status,
            firstChunk,
            elapsed,
            origin: self.location.origin,
            chrome: typeof chrome,
          });
        } catch (error) {
          self.postMessage({ error: error.message });
        }
      });`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Mock application</title><main>ready</main>');
  };
  siteServer = createHttpServer(serveMockApplication);
  otherSiteServer = createHttpServer(serveMockApplication);
  await listen(siteServer);
  if (!process.env.JUPYTERLITE_URL) await listen(otherSiteServer);

  apiServer = createHttpsServer({
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  }, async (request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
    response.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let markClosed;
    const record = {
      host: request.headers.host,
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'],
      googleApiKey: request.headers['x-goog-api-key'],
      anthropicVersion: request.headers['anthropic-version'],
      method: request.method,
      path: request.url,
      body: Buffer.concat(chunks).toString('utf8'),
      completed: false,
      cancelled: false,
      closed: new Promise((resolveClosed) => { markClosed = resolveClosed; }),
    };
    apiRequests.push(record);
    const isAnthropicStream = request.headers.host.startsWith('api.anthropic.com')
      && request.url === '/v1/messages'
      && JSON.parse(record.body).stream === true;
    const isGoogleStream = request.headers.host.startsWith('generativelanguage.googleapis.com')
      && request.url.startsWith('/v1beta/models/gemini-test-2026:streamGenerateContent');
    if (request.url === '/v1/stream' || isAnthropicStream || isGoogleStream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write(isAnthropicStream
        ? 'event: message_start\ndata: {"type":"message_start"}\n\n'
        : isGoogleStream
          ? 'data: {"candidates":[{"content":{"parts":[{"text":"first Google chunk"}]}}]}\n\n'
          : 'data: first-stream-chunk\n\n');
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        record.completed = true;
        response.end(isAnthropicStream
          ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          : 'data: final-stream-chunk\n\n');
      }, 4000);
      response.on('finish', () => {
        record.completed = true;
        clearTimeout(timer);
      });
      response.on('close', () => {
        record.cancelled = !record.completed;
        clearTimeout(timer);
        markClosed();
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.headers.host.startsWith('api.anthropic.com')
      ? { id: 'msg_mock', type: 'message', model: 'claude-test-2026-09', content: [{ type: 'text', text: 'mock response' }] }
      : request.headers.host.startsWith('generativelanguage.googleapis.com')
        ? { candidates: [{ content: { role: 'model', parts: [{ text: 'mock response' }] } }] }
        : { id: 'chatcmpl-mock', model: 'gpt-test-2026-09', choices: [] }));
  });
  await listen(apiServer);

  const localSiteOrigin = `http://127.0.0.1:${siteServer.address().port}`;
  const applicationUrl = process.env.JUPYTERLITE_URL ?? localSiteOrigin;
  const siteOrigin = new URL(applicationUrl).origin;
  const apiPort = apiServer.address().port;
  const profileDirectory = join(temporaryDirectory, 'profile');
  chrome = spawn(chromeExecutable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--ignore-certificate-errors',
    '--host-resolver-rules=MAP api.openai.com 127.0.0.1, MAP api.anthropic.com 127.0.0.1, MAP generativelanguage.googleapis.com 127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
    `--disable-extensions-except=${root}`, `--load-extension=${root}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const devtoolsFile = await waitFor(async () => {
    try {
      return await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8');
    } catch {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}`);
      return undefined;
    }
  });
  const [debuggingPort, browserPath] = devtoolsFile.trim().split('\n');
  const browserConnection = await CdpConnection.connect(`ws://127.0.0.1:${debuggingPort}${browserPath}`);
  browserConnections.push(browserConnection);

  const extensionId = await waitFor(async () => {
    const { targetInfos } = await browserConnection.send('Target.getTargets');
    const extensionTarget = targetInfos.find((target) => (
      target.type === 'service_worker' && target.url.endsWith('/src/background.js')
    ));
    return extensionTarget?.url.match(/^chrome-extension:\/\/([^/]+)/)?.[1];
  });

  const options = await openPage(browserConnection, `chrome-extension://${extensionId}/options.html`);
  browserConnections.push(options.connection);
  await options.waitUntil('document.querySelector("#assignment-form")?.dataset.ready === "true"');
  await options.evaluate(`(() => {
    document.querySelector('#origin').value = ${JSON.stringify(siteOrigin)};
    document.querySelector('#api-key').value = ${JSON.stringify(key)};
    document.querySelector('#save-assignment').click();
  })()`);
  await options.waitUntil(`document.querySelector('#assignments').textContent.includes(${JSON.stringify(siteOrigin)})`);
  const syncedStorage = await options.evaluate('chrome.storage.sync?.get(null) ?? {}');
  assert.deepEqual(syncedStorage, {});
  assert.equal(await options.evaluate(`document.querySelector('#assignments').textContent.includes(${JSON.stringify(key)})`), false);

  const page = await openPage(browserConnection, applicationUrl);
  browserConnections.push(page.connection);
  await page.waitUntil(process.env.JUPYTERLITE_URL
    ? `location.origin === ${JSON.stringify(siteOrigin)} && document.readyState === "complete"`
    : 'document.querySelector("main")?.textContent === "ready"');
  const applicationContext = await page.evaluate(`({ href: location.href, origin: location.origin, fetchName: window.fetch.name })`);
  assert.equal(applicationContext.origin, siteOrigin, JSON.stringify(applicationContext));

  const payload = {
    model: 'gpt-test-2026-09',
    messages: [{ role: 'user', content: 'Keep this payload unchanged.' }],
  };
  const pageResult = await pageOpenAiFetch(page, apiPort, payload, true);

  assert.ok(pageResult.status === 200, `page request failed: ${JSON.stringify({ pageResult, apiRequests })}`);
  assert.equal(pageResult.body.id, 'chatcmpl-mock');
  assert.equal(apiRequests.length, 1);
  assert.equal(apiRequests[0].authorization, `Bearer ${key}`);
  assert.equal(apiRequests[0].method, 'POST');
  assert.equal(apiRequests[0].path, '/v1/chat/completions');
  assert.deepEqual(JSON.parse(apiRequests[0].body), payload);
  assert.equal(pageResult.observed.includes(key), false);
  assert.equal(pageResult.storage.includes(key), false);

  const replacementKey = 'sk-test-replacement-credential';
  await saveAssignment(options, siteOrigin, replacementKey);
  const replacedResult = await pageOpenAiFetch(page, apiPort, payload);
  assert.ok(replacedResult.status === 200, `replacement failed: ${JSON.stringify({ replacedResult, apiRequests })}`);
  assert.equal(apiRequests[1].authorization, `Bearer ${replacementKey}`);
  assert.deepEqual(JSON.parse(apiRequests[1].body), payload);

  const streamResult = await page.evaluate(`(async () => {
    const started = performance.now();
    const response = await fetch('https://api.openai.com:${apiPort}/v1/stream', {
      method: 'POST',
      headers: { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(payload))},
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value);
    const elapsed = performance.now() - started;
    await reader.cancel();
    return { status: response.status, firstChunk, elapsed };
  })()`);
  assert.equal(streamResult.status, 200);
  assert.match(streamResult.firstChunk, /first-stream-chunk/);
  assert.ok(streamResult.elapsed < 2000, `first stream chunk took ${streamResult.elapsed}ms`);
  const streamRecord = apiRequests.find((request) => request.path === '/v1/stream');
  assert.equal(streamRecord.authorization, `Bearer ${replacementKey}`);
  await waitFor(() => streamRecord.cancelled);
  assert.equal(streamRecord.completed, false);

  const abortedBodyResult = await page.evaluate(`(async () => {
    const abortController = new AbortController();
    const delayedBody = new ReadableStream({
      start(controller) {
        setTimeout(() => controller.close(), 200);
      },
    });
    const request = fetch('https://api.openai.com:${apiPort}/v1/abort-during-body', {
      method: 'POST',
      headers: { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
      body: delayedBody,
      duplex: 'half',
      signal: abortController.signal,
    });
    abortController.abort();
    try {
      await request;
      return 'resolved';
    } catch (error) {
      return error.name;
    }
  })()`);
  assert.equal(abortedBodyResult, 'AbortError');
  await delay(300);
  assert.equal(apiRequests.some((request) => request.path === '/v1/abort-during-body'), false);

  const otherOrigin = process.env.JUPYTERLITE_URL
    ? `http://localhost:${siteServer.address().port}`
    : `http://127.0.0.1:${otherSiteServer.address().port}`;
  const otherPage = await openPage(browserConnection, otherOrigin);
  await otherPage.waitUntil('document.querySelector("main")?.textContent === "ready"');
  const unmatchedResult = await pageOpenAiFetch(otherPage, apiPort, payload);
  assert.equal(unmatchedResult.status, 200);
  assert.equal(apiRequests[3].authorization, 'Bearer page-placeholder');
  assert.deepEqual(JSON.parse(apiRequests[3].body), payload);

  await options.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-origin]')]
      .find((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)});
    row.querySelector('[data-action="remove-key"]').click();
  })()`);
  await options.waitUntil(`[...document.querySelectorAll('[data-origin]')]
    .find((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)})
    ?.textContent.includes('No key stored')`);
  const blockedResult = await pageOpenAiFetch(page, apiPort, payload);
  assert.equal(blockedResult.error?.name, 'TypeError');
  assert.equal(apiRequests.length, 4);

  await options.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-origin]')]
      .find((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)});
    row.querySelector('[data-action="remove-assignment"]').click();
  })()`);
  await options.waitUntil(`![...document.querySelectorAll('[data-origin]')]
    .some((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)})`);
  if (process.env.JUPYTERLITE_URL) {
    const assignmentRemains = await options.evaluate(`chrome.storage.local.get('openaiAssignments')
      .then((value) => Object.hasOwn(value.openaiAssignments ?? {}, ${JSON.stringify(siteOrigin)}))`);
    assert.equal(assignmentRemains, false);
  } else {
    const unassignedResult = await pageOpenAiFetch(page, apiPort, payload);
    assert.equal(unassignedResult.status, 200);
    assert.equal(apiRequests[4].authorization, 'Bearer page-placeholder');
    assert.equal(apiRequests.length, 5);
  }

  assert.equal(await options.evaluate('document.querySelector("#provider")?.tagName'), 'SELECT');
  await saveAssignment(options, siteOrigin, replacementKey, 'openai');
  const openAiAfterProviderAddition = await pageOpenAiFetch(page, apiPort, payload);
  assert.equal(openAiAfterProviderAddition.status, 200);
  assert.equal(apiRequests.at(-1).authorization, `Bearer ${replacementKey}`);

  const anthropicKey = 'sk-ant-test-registered-credential';
  const anthropicPayload = {
    model: 'claude-test-2026-09',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Keep this Anthropic payload unchanged.' }],
  };
  await saveAssignment(options, siteOrigin, anthropicKey, 'anthropic');
  const anthropicResult = await pageAnthropicFetch(page, apiPort, anthropicPayload, true);
  assert.equal(anthropicResult.status, 200, JSON.stringify({ anthropicResult, apiRequests }));
  assert.equal(anthropicResult.body.id, 'msg_mock');
  assert.equal(anthropicResult.observed.includes(anthropicKey), false);
  assert.equal(anthropicResult.storage.includes(anthropicKey), false);
  const anthropicRecord = apiRequests.find((request) => request.host.startsWith('api.anthropic.com'));
  assert.equal(anthropicRecord.apiKey, anthropicKey);
  assert.equal(anthropicRecord.authorization, undefined);
  assert.equal(anthropicRecord.anthropicVersion, '2023-06-01');
  assert.equal(anthropicRecord.path, '/v1/messages');
  assert.deepEqual(JSON.parse(anthropicRecord.body), anthropicPayload);

  const unmatchedAnthropicResult = await pageAnthropicFetch(otherPage, apiPort, anthropicPayload);
  assert.equal(unmatchedAnthropicResult.status, 200);
  const unmatchedAnthropicRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com'));
  assert.equal(unmatchedAnthropicRecord.apiKey, 'page-placeholder');
  assert.deepEqual(JSON.parse(unmatchedAnthropicRecord.body), anthropicPayload);

  const replacementAnthropicKey = 'sk-ant-test-replacement-credential';
  await saveAssignment(options, siteOrigin, replacementAnthropicKey, 'anthropic');
  const replacedAnthropicResult = await pageAnthropicFetch(page, apiPort, anthropicPayload);
  assert.equal(replacedAnthropicResult.status, 200);
  const replacedAnthropicRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com'));
  assert.equal(replacedAnthropicRecord.apiKey, replacementAnthropicKey);
  assert.deepEqual(JSON.parse(replacedAnthropicRecord.body), anthropicPayload);

  const anthropicStreamPayload = { ...anthropicPayload, stream: true };
  const anthropicStreamResult = await page.evaluate(`(async () => {
    const started = performance.now();
    const response = await fetch('https://api.anthropic.com:${apiPort}/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'page-placeholder',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: ${JSON.stringify(JSON.stringify(anthropicStreamPayload))},
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value);
    const elapsed = performance.now() - started;
    await reader.cancel();
    return { status: response.status, firstChunk, elapsed };
  })()`);
  assert.equal(anthropicStreamResult.status, 200);
  assert.match(anthropicStreamResult.firstChunk, /message_start/);
  assert.ok(anthropicStreamResult.elapsed < 2000);
  const anthropicStreamRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com') && JSON.parse(request.body).stream);
  assert.equal(anthropicStreamRecord.apiKey, replacementAnthropicKey);
  assert.deepEqual(JSON.parse(anthropicStreamRecord.body), anthropicStreamPayload);
  await waitFor(() => anthropicStreamRecord.cancelled);
  assert.equal(anthropicStreamRecord.completed, false);

  const abortedAnthropicStreamResult = await page.evaluate(`(async () => {
    const abortController = new AbortController();
    const response = await fetch('https://api.anthropic.com:${apiPort}/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'page-placeholder',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: ${JSON.stringify(JSON.stringify(anthropicStreamPayload))},
      signal: abortController.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    abortController.abort();
    try {
      await reader.read();
      return 'resolved';
    } catch (error) {
      return error.name;
    }
  })()`);
  assert.equal(abortedAnthropicStreamResult, 'AbortError');
  const abortedAnthropicRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com') && JSON.parse(request.body).stream);
  await waitFor(() => abortedAnthropicRecord.cancelled);
  assert.equal(abortedAnthropicRecord.completed, false);

  const anthropicRecordCount = apiRequests.filter((request) => request.host.startsWith('api.anthropic.com')).length;
  await clickAssignmentAction(options, siteOrigin, 'anthropic', 'remove-key');
  await options.waitUntil(`[...document.querySelectorAll('[data-provider]')]
    .find((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)}
      && entry.dataset.provider === 'anthropic')?.textContent.includes('No key stored')`);
  const blockedAnthropicResult = await pageAnthropicFetch(page, apiPort, anthropicPayload);
  assert.equal(blockedAnthropicResult.error?.name, 'TypeError');
  assert.equal(apiRequests.filter((request) => request.host.startsWith('api.anthropic.com')).length, anthropicRecordCount);

  await clickAssignmentAction(options, siteOrigin, 'anthropic', 'remove-assignment');
  await options.waitUntil(`![...document.querySelectorAll('[data-provider]')]
    .some((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)}
      && entry.dataset.provider === 'anthropic')`);
  const unassignedAnthropicResult = await pageAnthropicFetch(page, apiPort, anthropicPayload);
  assert.equal(unassignedAnthropicResult.status, 200);
  const unassignedAnthropicRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com'));
  assert.equal(unassignedAnthropicRecord.apiKey, 'page-placeholder');
  assert.deepEqual(JSON.parse(unassignedAnthropicRecord.body), anthropicPayload);

  const googleKey = 'test-google-registered-credential';
  const googlePayload = {
    contents: [{ role: 'user', parts: [{ text: 'Keep this Google AI payload unchanged.' }] }],
    generationConfig: { temperature: 0.2 },
  };
  await saveAssignment(options, siteOrigin, googleKey, 'google');
  const wrongOriginGoogleResult = await pageGoogleFetch(otherPage, apiPort, googlePayload);
  assert.equal(wrongOriginGoogleResult.status, 200);
  const wrongOriginGoogleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com'));
  assert.equal(wrongOriginGoogleRecord.googleApiKey, 'page-placeholder');
  const googleResult = await pageGoogleFetch(page, apiPort, googlePayload, true);
  assert.equal(googleResult.status, 200, JSON.stringify({ googleResult, apiRequests }));
  assert.equal(googleResult.body.candidates[0].content.parts[0].text, 'mock response');
  assert.equal(googleResult.observed.includes(googleKey), false);
  assert.equal(googleResult.storage.includes(googleKey), false);
  const googleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com'));
  assert.equal(googleRecord.googleApiKey, googleKey);
  assert.equal(googleRecord.apiKey, undefined);
  assert.equal(googleRecord.authorization, undefined);
  assert.equal(googleRecord.path, '/v1beta/models/gemini-test-2026:generateContent');
  assert.deepEqual(JSON.parse(googleRecord.body), googlePayload);

  const replacementGoogleKey = 'test-google-replacement-credential';
  await saveAssignment(options, siteOrigin, replacementGoogleKey, 'google');
  const replacedGoogleResult = await pageGoogleFetch(page, apiPort, googlePayload);
  assert.equal(replacedGoogleResult.status, 200);
  const replacedGoogleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com'));
  assert.equal(replacedGoogleRecord.googleApiKey, replacementGoogleKey);
  assert.deepEqual(JSON.parse(replacedGoogleRecord.body), googlePayload);

  const googleStreamResult = await page.evaluate(`(async () => {
    const response = await fetch('https://generativelanguage.googleapis.com:${apiPort}/v1beta/models/gemini-test-2026:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'page-placeholder', 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(googlePayload))},
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value);
    await reader.cancel();
    return { status: response.status, firstChunk };
  })()`);
  assert.equal(googleStreamResult.status, 200);
  assert.match(googleStreamResult.firstChunk, /first Google chunk/);
  const googleStreamRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com')
      && request.path.includes(':streamGenerateContent'));
  assert.equal(googleStreamRecord.googleApiKey, replacementGoogleKey);
  assert.equal(googleStreamRecord.path, '/v1beta/models/gemini-test-2026:streamGenerateContent?alt=sse');
  assert.deepEqual(JSON.parse(googleStreamRecord.body), googlePayload);
  await waitFor(() => googleStreamRecord.cancelled);
  assert.equal(googleStreamRecord.completed, false);

  const abortedGoogleStream = await page.evaluate(`(async () => {
    const abortController = new AbortController();
    const response = await fetch('https://generativelanguage.googleapis.com:${apiPort}/v1beta/models/gemini-test-2026:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'page-placeholder', 'content-type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(googlePayload))},
      signal: abortController.signal,
    });
    const reader = response.body.getReader();
    await reader.read();
    abortController.abort();
    try {
      await reader.read();
      return 'resolved';
    } catch (error) {
      return error.name;
    }
  })()`);
  assert.equal(abortedGoogleStream, 'AbortError');
  const abortedGoogleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com')
      && request.path.includes(':streamGenerateContent'));
  await waitFor(() => abortedGoogleRecord.cancelled);
  assert.equal(abortedGoogleRecord.completed, false);

  const googleRecordCount = apiRequests.filter((request) => request.host.startsWith('generativelanguage.googleapis.com')).length;
  await clickAssignmentAction(options, siteOrigin, 'google', 'remove-key');
  await options.waitUntil(`[...document.querySelectorAll('[data-provider]')]
    .find((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)}
      && entry.dataset.provider === 'google')?.textContent.includes('No key stored')`);
  const blockedGoogleResult = await pageGoogleFetch(page, apiPort, googlePayload);
  assert.equal(blockedGoogleResult.error?.name, 'TypeError');
  assert.equal(apiRequests.filter((request) => request.host.startsWith('generativelanguage.googleapis.com')).length, googleRecordCount);

  await clickAssignmentAction(options, siteOrigin, 'google', 'remove-assignment');
  await options.waitUntil(`![...document.querySelectorAll('[data-provider]')]
    .some((entry) => entry.dataset.origin === ${JSON.stringify(siteOrigin)}
      && entry.dataset.provider === 'google')`);
  const unmatchedGoogleResult = await pageGoogleFetch(otherPage, apiPort, googlePayload);
  assert.equal(unmatchedGoogleResult.status, 200);
  const unmatchedGoogleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com'));
  assert.equal(unmatchedGoogleRecord.googleApiKey, 'page-placeholder');
  assert.deepEqual(JSON.parse(unmatchedGoogleRecord.body), googlePayload);

  const workerPayload = {
    model: 'gpt-test-2026-09',
    messages: [{ role: 'user', content: 'Preserve this worker payload.' }],
  };
  let workerResult;
  try {
    workerResult = await workerFetch(
      page,
      `https://api.openai.com:${apiPort}/v1/stream`,
      workerPayload,
      { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
      true,
      true,
    );
  } catch (error) {
    throw new Error(`${error.message}; worker scripts fetched: ${workerScriptRequests.length}`);
  }
  assert.equal(workerScriptRequests.length, 1);
  assert.equal(workerResult.status, 200);
  assert.match(workerResult.firstChunk, /first-stream-chunk/);
  assert.ok(workerResult.elapsed < 2000, `first worker stream chunk took ${workerResult.elapsed}ms`);
  assert.equal(workerResult.origin, siteOrigin);
  assert.equal(workerResult.chrome, 'undefined');
  assert.equal(JSON.stringify(workerResult).includes(key), false);
  const workerRecord = [...apiRequests].reverse().find((request) => (
    request.path === '/v1/stream' && JSON.parse(request.body).messages[0].content === workerPayload.messages[0].content
  ));
  assert.equal(workerRecord.authorization, `Bearer ${replacementKey}`);
  assert.deepEqual(JSON.parse(workerRecord.body), workerPayload);
  await waitFor(() => workerRecord.cancelled);
  assert.equal(workerRecord.completed, false);

  const workerAnthropicPayload = {
    model: 'claude-test-2026-09',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Preserve this Anthropic worker payload.' }],
  };
  await saveAssignment(options, siteOrigin, replacementAnthropicKey, 'anthropic');
  const workerAnthropicResult = await workerFetch(
    page,
    `https://api.anthropic.com:${apiPort}/v1/messages`,
    workerAnthropicPayload,
    {
      'x-api-key': 'page-placeholder',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  );
  assert.equal(workerAnthropicResult.status, 200);
  const workerAnthropicRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('api.anthropic.com')
      && JSON.parse(request.body).messages[0].content === workerAnthropicPayload.messages[0].content);
  assert.equal(workerAnthropicRecord.apiKey, replacementAnthropicKey);
  assert.equal(workerAnthropicRecord.anthropicVersion, '2023-06-01');
  assert.deepEqual(JSON.parse(workerAnthropicRecord.body), workerAnthropicPayload);

  await saveAssignment(options, siteOrigin, googleKey, 'google');
  const workerGooglePayload = {
    contents: [{ role: 'user', parts: [{ text: 'Preserve this Google AI worker payload.' }] }],
    generationConfig: { temperature: 0.3 },
  };
  const workerGoogleResult = await workerFetch(
    page,
    `https://generativelanguage.googleapis.com:${apiPort}/v1beta/models/gemini-test-2026:generateContent?key=page-placeholder`,
    workerGooglePayload,
    { 'x-goog-api-key': 'page-placeholder', 'content-type': 'application/json' },
  );
  assert.equal(workerGoogleResult.status, 200);
  const workerGoogleRecord = [...apiRequests].reverse()
    .find((request) => request.host.startsWith('generativelanguage.googleapis.com')
      && JSON.parse(request.body).contents?.[0]?.parts?.[0]?.text === workerGooglePayload.contents[0].parts[0].text);
  assert.equal(workerGoogleRecord.googleApiKey, googleKey);
  assert.equal(workerGoogleRecord.path, '/v1beta/models/gemini-test-2026:generateContent');
  assert.deepEqual(JSON.parse(workerGoogleRecord.body), workerGooglePayload);

  const workerCredentials = [key, replacementKey, anthropicKey, replacementAnthropicKey, googleKey];
  const workerResults = [workerResult, workerAnthropicResult, workerGoogleResult];
  const observedWorkerMessages = JSON.stringify(await page.evaluate('window.__workerObservedMessages ?? []'));
  for (const credential of workerCredentials) {
    assert.equal(JSON.stringify(workerResults).includes(credential), false);
    assert.equal(observedWorkerMessages.includes(credential), false);
  }

  const unintegratedPayload = {
    model: 'gpt-test-2026-09',
    messages: [{ role: 'user', content: 'Do not integrate this worker.' }],
  };
  const unintegratedResult = await workerFetch(
    page,
    `https://api.openai.com:${apiPort}/v1/stream`,
    unintegratedPayload,
    { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
    false,
  );
  assert.equal(unintegratedResult.status, 200);
  const unintegratedRecord = [...apiRequests].reverse()
    .find((request) => request.path === '/v1/stream'
      && JSON.parse(request.body).messages[0].content === unintegratedPayload.messages[0].content);
  assert.equal(unintegratedRecord.authorization, 'Bearer page-placeholder');

  const unmatchedWorkerResult = await workerFetch(
    otherPage,
    `https://api.openai.com:${apiPort}/v1/stream`,
    workerPayload,
    { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
  );
  assert.equal(unmatchedWorkerResult.status, 200);
  const unmatchedWorkerRecord = [...apiRequests].reverse()
    .find((request) => request.path === '/v1/stream'
      && JSON.parse(request.body).messages[0].content === workerPayload.messages[0].content);
  assert.equal(unmatchedWorkerRecord.authorization, 'Bearer page-placeholder');
  assert.deepEqual(JSON.parse(unmatchedWorkerRecord.body), workerPayload);

  const terminatedPayload = {
    model: 'gpt-test-2026-09',
    messages: [{ role: 'user', content: 'Cancel when the worker terminates.' }],
  };
  await page.evaluate(`new Promise((resolve, reject) => {
    const worker = window.BrowserAIConnector.createWorker(new URL('/dedicated-worker.js', location.href));
    const timeout = setTimeout(() => reject(new Error('termination worker timed out')), 5000);
    worker.addEventListener('message', (event) => {
      if (!event.data.readyToTerminate) return;
      clearTimeout(timeout);
      worker.terminate();
      resolve(true);
    });
    worker.addEventListener('error', (event) => {
      clearTimeout(timeout);
      reject(new Error(event.message));
    }, { once: true });
    worker.postMessage({
      url: 'https://api.openai.com:${apiPort}/v1/stream',
      payload: ${JSON.stringify(terminatedPayload)},
      headers: { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
      terminateAfterResponse: true,
    });
  })`);
  const terminatedRecord = [...apiRequests].reverse()
    .find((request) => request.path === '/v1/stream'
      && JSON.parse(request.body).messages[0].content === terminatedPayload.messages[0].content);
  await waitFor(() => terminatedRecord.cancelled);
  assert.equal(terminatedRecord.authorization, `Bearer ${replacementKey}`);
  assert.equal(terminatedRecord.completed, false);
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function findChromeExecutable() {
  const pathDirectories = (process.env.PATH ?? '').split(':').filter(Boolean);
  const chromiumCommands = pathDirectories.flatMap((directory) => (
    ['chromium', 'chromium-browser'].map((name) => join(directory, name))
  ));
  const playwrightCache = join(homedir(), '.cache', 'ms-playwright');
  const cachedChromiums = (await readdir(playwrightCache).catch(() => []))
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((name) => join(playwrightCache, name, 'chrome-linux64', 'chrome'));
  const chromeCommands = pathDirectories.flatMap((directory) => (
    ['google-chrome', 'google-chrome-stable'].map((name) => join(directory, name))
  ));

  for (const candidate of [...chromiumCommands, ...cachedChromiums, ...chromeCommands]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return 'google-chrome';
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function stopBrowser(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  const exited = once(browser, 'exit');
  browser.kill('SIGTERM');
  await exited;
}

async function waitFor(readValue, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await readValue();
    if (lastValue !== undefined && lastValue !== false) return lastValue;
    await delay(50);
  }
  throw new Error(`Timed out waiting for browser state; last value: ${String(lastValue)}`);
}

async function openPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  return {
    connection: browser,
    async evaluate(expression) {
      const result = await browser.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    async waitUntil(expression) {
      try {
        return await waitFor(async () => this.evaluate(expression));
      } catch (error) {
        const documentState = await this.evaluate('JSON.stringify({ href: location.href, title: document.title, body: document.body?.innerText })');
        throw new Error(`${error.message}; document: ${documentState}`);
      }
    },
  };
}

async function saveAssignment(options, origin, key, provider = 'openai') {
  await options.evaluate(`(() => {
    const providerSelect = document.querySelector('#provider');
    if (providerSelect) providerSelect.value = ${JSON.stringify(provider)};
    document.querySelector('#origin').value = ${JSON.stringify(origin)};
    document.querySelector('#api-key').value = ${JSON.stringify(key)};
    document.querySelector('#save-assignment').click();
  })()`);
  await options.waitUntil('document.querySelector("#status").textContent === "Assignment saved."');
}

async function clickAssignmentAction(options, origin, provider, action) {
  await options.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-provider]')]
      .find((entry) => entry.dataset.origin === ${JSON.stringify(origin)}
        && entry.dataset.provider === ${JSON.stringify(provider)});
    row.querySelector('[data-action="${action}"]').click();
  })()`);
}

async function pageAnthropicFetch(page, apiPort, payload, observeKey = false) {
  return page.evaluate(`(async () => {
    ${observeKey ? "window.__observedMessages = []; addEventListener('message', (event) => window.__observedMessages.push(event.data));" : ''}
    try {
      const response = await fetch('https://api.anthropic.com:${apiPort}/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': 'page-placeholder',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: ${JSON.stringify(JSON.stringify(payload))},
      });
      return {
        status: response.status,
        body: await response.json(),
        observed: JSON.stringify(window.__observedMessages ?? []),
        storage: (() => {
          try {
            return JSON.stringify([localStorage, sessionStorage]);
          } catch {
            return 'inaccessible';
          }
        })(),
      };
    } catch (error) {
      return { error: { name: error.name, message: error.message } };
    }
  })()`);
}

async function pageGoogleFetch(page, apiPort, payload, observeKey = false) {
  return page.evaluate(`(async () => {
    ${observeKey ? "window.__observedMessages = []; addEventListener('message', (event) => window.__observedMessages.push(event.data));" : ''}
    try {
      const response = await fetch('https://generativelanguage.googleapis.com:${apiPort}/v1beta/models/gemini-test-2026:generateContent?key=page-placeholder', {
        method: 'POST',
        headers: { 'x-goog-api-key': 'page-placeholder', 'content-type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(payload))},
      });
      return {
        status: response.status,
        body: await response.json(),
        observed: JSON.stringify(window.__observedMessages ?? []),
        storage: (() => {
          try {
            return JSON.stringify([localStorage, sessionStorage]);
          } catch {
            return 'inaccessible';
          }
        })(),
      };
    } catch (error) {
      return { error: { name: error.name, message: error.message } };
    }
  })()`);
}

async function workerFetch(page, url, payload, headers, integrated = true, observeMessages = false) {
  const observeWorkerMessages = observeMessages
    ? "window.__workerObservedMessages = []; addEventListener('message', (event) => window.__workerObservedMessages.push(event.data));"
    : '';
  const createWorker = integrated
    ? "window.BrowserAIConnector.createWorker(new URL('/dedicated-worker.js', location.href))"
    : "new Worker(new URL('/dedicated-worker.js', location.href))";
  return page.evaluate(`(async () => {
    ${observeWorkerMessages}
    const worker = ${createWorker};
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('worker timed out')), 5000);
        worker.addEventListener('message', (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        }, { once: true });
        worker.addEventListener('error', (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        }, { once: true });
        worker.postMessage({
          url: ${JSON.stringify(url)},
          payload: ${JSON.stringify(payload)},
          headers: ${JSON.stringify(headers)},
        });
      });
    } finally {
      worker.terminate();
    }
  })()`);
}

async function pageOpenAiFetch(page, apiPort, payload, observeKey = false) {
  return page.evaluate(`(async () => {
    ${observeKey ? "window.__observedMessages = []; addEventListener('message', (event) => window.__observedMessages.push(event.data));" : ''}
    try {
      const response = await fetch('https://api.openai.com:${apiPort}/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer page-placeholder', 'content-type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(payload))},
      });
      return {
        status: response.status,
        body: await response.json(),
        observed: JSON.stringify(window.__observedMessages ?? []),
        storage: (() => {
          try {
            return JSON.stringify([localStorage, sessionStorage]);
          } catch {
            return 'inaccessible';
          }
        })(),
      };
    } catch (error) {
      return { error: { name: error.name, message: error.message } };
    }
  })()`);
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
    });
    return new CdpConnection(socket);
  }

  send(method, params, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}