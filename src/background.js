const storageKey = 'openaiAssignments';
const maximumRequestBytes = 8 * 1024 * 1024;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.url !== chrome.runtime.getURL('options.html')) return false;
  return manageAssignments(message);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'openai-relay') return;
  const calls = new Map();

  port.onMessage.addListener((message) => {
    if (message.type === 'request') {
      const call = { controller: new AbortController(), acknowledge: null };
      calls.set(message.id, call);
      relayRequest(port, message, call, calls);
      return;
    }
    const call = calls.get(message.id);
    if (!call) return;
    if (message.type === 'cancel') {
      call.controller.abort();
      call.acknowledge?.();
      calls.delete(message.id);
    }
    if (message.type === 'ack') call.acknowledge?.();
  });

  port.onDisconnect.addListener(() => {
    for (const call of calls.values()) {
      call.controller.abort();
      call.acknowledge?.();
    }
    calls.clear();
  });
});

async function manageAssignments(message) {
  const stored = await chrome.storage.local.get(storageKey);
  const assignments = stored[storageKey] ?? {};

  if (message?.type === 'list-assignments') {
    return Object.entries(assignments)
      .map(([origin, assignment]) => ({ origin, hasKey: usableKey(assignment?.apiKey) }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
  }

  if (message?.type === 'save-assignment') {
    const origin = validateOrigin(message.origin);
    if (!origin || typeof message.apiKey !== 'string' || !message.apiKey.trim()) {
      throw new Error('Enter a valid page origin and a non-empty API key.');
    }
    assignments[origin] = { apiKey: message.apiKey };
    await chrome.storage.local.set({ [storageKey]: assignments });
    return { saved: true };
  }

  if (message?.type === 'remove-key') {
    const origin = validateOrigin(message.origin);
    if (!origin || !Object.hasOwn(assignments, origin)) return { updated: false };
    assignments[origin] = { apiKey: null };
    await chrome.storage.local.set({ [storageKey]: assignments });
    return { updated: true };
  }

  if (message?.type === 'remove-assignment') {
    const origin = validateOrigin(message.origin);
    if (!origin) return { updated: false };
    delete assignments[origin];
    await chrome.storage.local.set({ [storageKey]: assignments });
    return { updated: true };
  }

  throw new Error('Unsupported management operation.');
}

async function relayRequest(port, message, call, calls) {
  const senderOrigin = new URL(port.sender.url).origin;
  const requestUrl = new URL(message.url);
  if (requestUrl.protocol !== 'https:' || requestUrl.hostname !== 'api.openai.com' || !requestUrl.pathname.startsWith('/v1/')) {
    port.postMessage({ type: 'route', id: message.id, route: 'native' });
    calls.delete(message.id);
    return;
  }

  const stored = await chrome.storage.local.get(storageKey);
  const assignment = stored[storageKey]?.[senderOrigin];
  if (!assignment) {
    port.postMessage({ type: 'route', id: message.id, route: 'native' });
    calls.delete(message.id);
    return;
  }
  if (!usableKey(assignment.apiKey)) {
    port.postMessage({ type: 'route', id: message.id, route: 'blocked' });
    calls.delete(message.id);
    return;
  }
  if (!Array.isArray(message.body) || message.body.length > maximumRequestBytes) {
    port.postMessage({ type: 'error', id: message.id });
    calls.delete(message.id);
    return;
  }

  try {
    const headers = new Headers(message.headers);
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) headers.delete(name);
    headers.set('authorization', `Bearer ${assignment.apiKey}`);
    const method = String(message.method).toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);
    const response = await fetch(requestUrl, {
      method,
      headers,
      ...(hasBody ? { body: new Uint8Array(message.body) } : {}),
      signal: call.controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    port.postMessage({
      type: 'response-start',
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const acknowledged = new Promise((resolve) => { call.acknowledge = resolve; });
        port.postMessage({ type: 'response-chunk', id: message.id, chunk: Array.from(value) });
        await acknowledged;
        call.acknowledge = null;
        if (call.controller.signal.aborted) break;
      }
    }
    if (!call.controller.signal.aborted) port.postMessage({ type: 'response-end', id: message.id });
  } catch {
    if (!call.controller.signal.aborted) port.postMessage({ type: 'error', id: message.id });
  } finally {
    calls.delete(message.id);
  }
}

function validateOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === 'https:' || (
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
    if (!allowedProtocol || url.origin !== value || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function usableKey(value) {
  return typeof value === 'string' && value.trim().length > 0;
}