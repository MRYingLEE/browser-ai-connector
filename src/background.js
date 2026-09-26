const assignmentStorageKeys = {
  openai: 'openaiAssignments',
  anthropic: 'anthropicAssignments',
  google: 'googleAssignments',
  agnes: 'agnesAssignments',
  azure: 'azureAssignments',
};
const customProviderStorageKey = 'customProviderAssignments';
const openAiTextGenerationPaths = new Set([
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
]);
const maximumRequestBytes = 8 * 1024 * 1024;
const maximumRequestLogEntries = 100;
const entraTokenScope = 'https://cognitiveservices.azure.com/.default';
const entraTokens = new Map();
const requestLogs = [];
let nextRequestLogId = 1;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'list-custom-endpoints' && sender.tab) return listCustomEndpoints();
  if (sender.url !== chrome.runtime.getURL('options.html')) return false;
  return manageAssignments(message);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'provider-relay') return;
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
  if (message?.type === 'list-request-logs') return requestLogs.map((entry) => ({ ...entry }));

  const stored = await chrome.storage.local.get([...Object.values(assignmentStorageKeys), customProviderStorageKey]);

  if (message?.type === 'list-assignments') {
    const standardAssignments = Object.entries(assignmentStorageKeys)
      .flatMap(([provider, storageKey]) => Object.entries(stored[storageKey] ?? {})
        .map(([origin, assignment]) => ({
          provider,
          origin,
          hasKey: usableKey(assignment?.apiKey) || usableKey(assignment?.clientSecret),
          endpoint: assignment?.endpoint,
          authMode: assignment?.authMode,
        })));
    const customAssignments = Object.entries(stored[customProviderStorageKey] ?? {})
      .flatMap(([endpoint, service]) => Object.entries(service.assignments ?? {})
        .map(([origin, assignment]) => ({
          provider: `custom:${endpoint}`,
          providerName: service.name,
          origin,
          endpoint,
          hasKey: usableKey(assignment?.apiKey),
          customAuthMode: service.authMode,
          headerName: service.headerName,
          queryParam: service.queryParam,
        })));
    return [...standardAssignments, ...customAssignments]
      .sort((left, right) => left.origin.localeCompare(right.origin) || (left.providerName ?? left.provider).localeCompare(right.providerName ?? right.provider));
  }

  const customServices = stored[customProviderStorageKey] ?? {};
  const provider = validateProvider(message?.provider ?? 'openai', customServices);
  if (!provider) throw new Error('Choose a supported provider.');
  const customEndpoint = provider.startsWith('custom:') ? provider.slice('custom:'.length) : null;
  const isCustomAssignment = customEndpoint !== null;
  const storageKey = isCustomAssignment ? customProviderStorageKey : assignmentStorageKeys[provider];
  const customService = isCustomAssignment ? customServices[customEndpoint] : null;
  const assignments = isCustomAssignment ? customService.assignments ?? {} : stored[storageKey] ?? {};

  if (message?.type === 'save-assignment') {
    const origin = validateOrigin(message.origin);
    if (!origin) throw new Error('Enter a valid page origin.');
    if (provider === 'custom') {
      const endpoint = validateCustomEndpoint(message.endpoint);
      if (!endpoint) throw new Error('Enter a valid HTTPS provider API base URL, or a localhost URL for development.');
      const name = validateCustomName(message.providerName);
      if (!name) throw new Error('Enter a provider name.');
      if (!usableKey(message.apiKey)) throw new Error('Enter a non-empty API key.');
      const authMode = message.customAuthMode;
      if (!['bearer', 'header', 'query'].includes(authMode)) throw new Error('Choose a supported credential format.');
      const service = customServices[endpoint] ?? { endpoint, assignments: {} };
      service.name = name;
      service.authMode = authMode;
      if (authMode === 'header') {
        const headerName = validateCustomHeaderName(message.headerName);
        const headerPrefix = validateHeaderPrefix(message.headerPrefix);
        if (!headerName || headerPrefix === null) throw new Error('Enter a valid credential header and prefix.');
        service.headerName = headerName;
        service.headerPrefix = headerPrefix;
        delete service.queryParam;
      } else if (authMode === 'query') {
        const queryParam = validateQueryParameter(message.queryParam);
        if (!queryParam) throw new Error('Enter a valid credential query parameter.');
        service.queryParam = queryParam;
        delete service.headerName;
        delete service.headerPrefix;
      } else {
        delete service.queryParam;
        delete service.headerName;
        delete service.headerPrefix;
      }
      service.assignments = { ...service.assignments, [origin]: { apiKey: message.apiKey } };
      customServices[endpoint] = service;
      await chrome.storage.local.set({ [customProviderStorageKey]: customServices });
      return { saved: true };
    }
    if (provider === 'azure') {
      const endpoint = validateAzureEndpoint(message.endpoint);
      if (!endpoint) throw new Error('Enter an Azure OpenAI resource URL such as https://my-resource.openai.azure.com.');
      if (message.authMode === 'entra') {
        if (![message.tenantId, message.clientId, message.clientSecret].every(usableKey)) {
          throw new Error('Enter the Entra tenant ID, client ID, and client secret value.');
        }
        assignments[origin] = {
          endpoint,
          authMode: 'entra',
          tenantId: message.tenantId.trim(),
          clientId: message.clientId.trim(),
          clientSecret: message.clientSecret,
        };
      } else {
        if (!usableKey(message.apiKey)) throw new Error('Enter an Azure OpenAI API key.');
        assignments[origin] = { endpoint, authMode: 'api-key', apiKey: message.apiKey };
      }
    } else {
      if (!usableKey(message.apiKey)) throw new Error('Enter a non-empty API key.');
      assignments[origin] = { apiKey: message.apiKey };
    }
    await chrome.storage.local.set({ [storageKey]: assignments });
    entraTokens.delete(`${provider}:${origin}`);
    return { saved: true };
  }

  if (message?.type === 'remove-key') {
    const origin = validateOrigin(message.origin);
    if (!origin || !Object.hasOwn(assignments, origin)) return { updated: false };
    assignments[origin] = { ...assignments[origin], apiKey: null, clientSecret: null };
    if (isCustomAssignment) customService.assignments = assignments;
    await chrome.storage.local.set({ [storageKey]: isCustomAssignment ? customServices : assignments });
    if (!isCustomAssignment) entraTokens.delete(`${provider}:${origin}`);
    return { updated: true };
  }

  if (message?.type === 'remove-assignment') {
    const origin = validateOrigin(message.origin);
    if (!origin) return { updated: false };
    delete assignments[origin];
    if (isCustomAssignment) {
      if (Object.keys(assignments).length === 0) delete customServices[customEndpoint];
      else customService.assignments = assignments;
    }
    await chrome.storage.local.set({ [storageKey]: isCustomAssignment ? customServices : assignments });
    if (!isCustomAssignment) entraTokens.delete(`${provider}:${origin}`);
    return { updated: true };
  }

  throw new Error('Unsupported management operation.');
}

async function listCustomEndpoints() {
  const stored = await chrome.storage.local.get(customProviderStorageKey);
  return Object.values(stored[customProviderStorageKey] ?? {}).map((service) => service.endpoint);
}

function validateProvider(value, customServices) {
  if (Object.hasOwn(assignmentStorageKeys, value) || value === 'custom') return value;
  if (typeof value === 'string' && value.startsWith('custom:')
    && Object.hasOwn(customServices, value.slice('custom:'.length))) return value;
  return null;
}

async function relayRequest(port, message, call, calls) {
  const senderOrigin = new URL(port.sender.url).origin;
  const requestUrl = new URL(message.url);
  let provider = providerForRequest(requestUrl, message.method);
  let customService = null;
  if (!provider) {
    const storedCustomServices = await chrome.storage.local.get(customProviderStorageKey);
    const customServices = storedCustomServices[customProviderStorageKey] ?? {};
    customService = findCustomProvider(requestUrl, message.method, customServices);
    if (customService) provider = `custom:${customService.endpoint}`;
  }
  if (!provider) {
    port.postMessage({ type: 'route', id: message.id, route: 'native' });
    calls.delete(message.id);
    return;
  }
  const logEntry = addRequestLog(senderOrigin, customService?.name ?? provider, message.method, requestUrl);
  if (provider === 'google') requestUrl.searchParams.delete('key');

  const storageKey = customService ? customProviderStorageKey : assignmentStorageKeys[provider];
  const stored = customService ? null : await chrome.storage.local.get(storageKey);
  const assignment = customService
    ? customService.assignments?.[senderOrigin]
    : stored[storageKey]?.[senderOrigin];
  if (!assignment) {
    updateRequestLog(logEntry, 'Native (no assignment)');
    port.postMessage({ type: 'route', id: message.id, route: 'native' });
    calls.delete(message.id);
    return;
  }
  const hasCredential = customService
    ? usableKey(assignment.apiKey)
    : provider === 'azure'
    ? assignment.authMode === 'entra'
      ? usableKey(assignment.tenantId) && usableKey(assignment.clientId) && usableKey(assignment.clientSecret)
      : usableKey(assignment.apiKey)
    : usableKey(assignment.apiKey);
  if (!hasCredential) {
    updateRequestLog(logEntry, 'Blocked (no credential)');
    port.postMessage({ type: 'route', id: message.id, route: 'blocked' });
    calls.delete(message.id);
    return;
  }
  if (!Array.isArray(message.body) || message.body.length > maximumRequestBytes) {
    updateRequestLog(logEntry, 'Rejected (request too large)');
    port.postMessage({ type: 'error', id: message.id });
    calls.delete(message.id);
    return;
  }

  try {
    updateRequestLog(logEntry, 'Sending');
    if (provider === 'azure') {
      const destination = new URL(assignment.endpoint);
      requestUrl.hostname = destination.hostname;
      requestUrl.port = destination.port;
    }
    const headers = new Headers(message.headers);
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'api-key']) headers.delete(name);
    if (customService?.authMode === 'query') requestUrl.searchParams.set(customService.queryParam, assignment.apiKey);
    else if (customService?.authMode === 'header') headers.set(customService.headerName, `${customService.headerPrefix}${assignment.apiKey}`);
    else if (customService) headers.set('authorization', `Bearer ${assignment.apiKey}`);
    else if (provider === 'openai' || provider === 'agnes') headers.set('authorization', `Bearer ${assignment.apiKey}`);
    else if (provider === 'anthropic') headers.set('x-api-key', assignment.apiKey);
    else if (provider === 'google') headers.set('x-goog-api-key', assignment.apiKey);
    else if (assignment.authMode === 'entra') {
      headers.set('authorization', `Bearer ${await getEntraToken(assignment, senderOrigin, call.controller.signal)}`);
    } else {
      headers.set('api-key', assignment.apiKey);
    }
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
    updateRequestLog(logEntry, `HTTP ${response.status}`);
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
    updateRequestLog(logEntry, call.controller.signal.aborted ? 'Canceled' : 'Request failed');
    if (!call.controller.signal.aborted) port.postMessage({ type: 'error', id: message.id });
  } finally {
    if (call.controller.signal.aborted) updateRequestLog(logEntry, 'Canceled');
    calls.delete(message.id);
  }
}

function addRequestLog(origin, provider, method, url) {
  const entry = {
    id: nextRequestLogId++,
    timestamp: new Date().toISOString(),
    origin,
    provider,
    method: String(method).toUpperCase(),
    url: `${url.origin}${url.pathname}`,
    status: 'Checking assignment',
  };
  requestLogs.unshift(entry);
  if (requestLogs.length > maximumRequestLogEntries) requestLogs.pop();
  return entry;
}

function updateRequestLog(entry, status) {
  entry.status = status;
}

function providerForRequest(url, method) {
  if (url.protocol !== 'https:' || String(method).toUpperCase() !== 'POST') return null;
  if (url.hostname === 'api.openai.com' && openAiTextGenerationPaths.has(url.pathname)) return 'openai';
  if (url.hostname === 'api.anthropic.com' && url.pathname === '/v1/messages') return 'anthropic';
  if (url.hostname === 'apihub.agnes-ai.com' && openAiTextGenerationPaths.has(url.pathname)) return 'agnes';
  if (/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname)
    && (/^\/openai\/v1\/(?:chat\/completions|completions|responses)$/.test(url.pathname)
      || /^\/openai\/deployments\/[^/]+\/(?:chat\/completions|completions)$/.test(url.pathname))) return 'azure';
  if (url.hostname === 'generativelanguage.googleapis.com'
    && /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(url.pathname)) return 'google';
  return null;
}

function findCustomProvider(url, method, customServices) {
  if (url.protocol !== 'https:' && !isLocalhostUrl(url)) return null;
  if (String(method).toUpperCase() !== 'POST') return null;
  return Object.values(customServices)
    .filter((service) => {
      const base = new URL(service.endpoint);
      const basePath = base.pathname.replace(/\/+$/, '');
      return url.origin === base.origin
        && (basePath === '' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
    })
    .sort((left, right) => right.endpoint.length - left.endpoint.length)[0] ?? null;
}

function validateCustomEndpoint(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !isLocalhostUrl(url)) || url.search || url.hash || url.username || url.password) return null;
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function isLocalhostUrl(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function validateCustomName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 ? name : null;
}

function validateCustomHeaderName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    || ['cookie', 'set-cookie', 'proxy-authorization', 'host', 'origin', 'referer', 'content-length'].includes(name.toLowerCase())) return null;
  return name;
}

function validateHeaderPrefix(value) {
  return typeof value === 'string' && value.length <= 64 && !/[\r\n]/.test(value) ? value : null;
}

function validateQueryParameter(value) {
  if (typeof value !== 'string') return null;
  const parameter = value.trim();
  return /^[A-Za-z0-9_.~-]{1,64}$/.test(parameter) ? parameter : null;
}

function validateAzureEndpoint(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname)
      || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function getEntraToken(assignment, origin, signal) {
  const cacheKey = `azure:${origin}`;
  const cached = entraTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 30_000);
  try {
    const body = new URLSearchParams({
      client_id: assignment.clientId,
      client_secret: assignment.clientSecret,
      scope: entraTokenScope,
      grant_type: 'client_credentials',
    });
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(assignment.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Entra token request failed.');
    const token = await response.json();
    if (!usableKey(token.access_token) || !Number.isFinite(Number(token.expires_in))) {
      throw new Error('Entra token response was invalid.');
    }
    entraTokens.set(cacheKey, {
      accessToken: token.access_token,
      expiresAt: Date.now() + Number(token.expires_in) * 1000,
    });
    return token.access_token;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
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