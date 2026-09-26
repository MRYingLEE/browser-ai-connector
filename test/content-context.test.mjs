import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const contentScript = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');

test('invalidated extension contexts fall back for page and worker requests', () => {
  const listeners = new Map();
  const postedMessages = [];
  const window = {
    location: { origin: 'https://app.example' },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin });
    },
  };
  const chrome = {
    runtime: {
      sendMessage: async () => [],
      connect() {
        throw new Error('Extension context invalidated.');
      },
    },
    storage: { onChanged: { addListener() {} } },
  };

  runInNewContext(contentScript, { chrome, window });

  const workerChannel = 'browser-ai-connector-v1-worker-123e4567-e89b-42d3-a456-426614174000';
  const requests = [
    {
      message: { type: 'request', id: 'page-request' },
      reply: { channel: 'browser-ai-connector-v1', direction: 'extension', type: 'route', id: 'page-request', route: 'native' },
    },
    {
      message: { direction: 'worker', workerChannel, type: 'request', id: 'worker-request' },
      reply: { channel: 'browser-ai-connector-v1', direction: 'worker-extension', workerChannel, type: 'route', id: 'worker-request', route: 'native' },
    },
  ];

  for (const { message, reply } of requests) {
    assert.doesNotThrow(() => listeners.get('message')({
      source: window,
      origin: window.location.origin,
      data: { channel: 'browser-ai-connector-v1', ...message },
    }));
    assert.equal(JSON.stringify(postedMessages.at(-1)), JSON.stringify({ message: reply, targetOrigin: window.location.origin }));
  }
});