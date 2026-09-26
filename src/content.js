(() => {
  const channel = 'browser-ai-connector-v1';
  const calls = new Map();
  const workerBridges = new Map();

  async function publishCustomProviderEndpoints() {
    try {
      const endpoints = await chrome.runtime.sendMessage({ type: 'list-custom-endpoints' });
      window.postMessage({ channel, type: 'custom-provider-endpoints', endpoints }, window.location.origin);
    } catch {
      window.postMessage({ channel, type: 'custom-provider-endpoints', endpoints: [] }, window.location.origin);
    }
  }

  function connectProviderRelay() {
    try {
      return chrome.runtime.connect({ name: 'provider-relay' });
    } catch {
      return null;
    }
  }

  function postProviderMessage(port, message) {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  function disconnectProviderPort(port) {
    try {
      port.disconnect();
    } catch {}
  }

  function routeNative(message, workerChannel) {
    window.postMessage({
      channel,
      ...(workerChannel ? { direction: 'worker-extension', workerChannel } : { direction: 'extension' }),
      type: 'route',
      id: message.id,
      route: 'native',
    }, window.location.origin);
  }

  void publishCustomProviderEndpoints();
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.customProviderAssignments) void publishCustomProviderEndpoints();
    });
  } catch {}

  function closeWorkerBridge(workerChannel) {
    const bridge = workerBridges.get(workerChannel);
    if (!bridge) return;
    workerBridges.delete(workerChannel);
    for (const [id, port] of bridge.calls) {
      postProviderMessage(port, { type: 'cancel', id });
      disconnectProviderPort(port);
    }
    bridge.calls.clear();
  }

  function connectWorkerBridge(workerChannel) {
    const prefix = `${channel}-worker-`;
    if (typeof workerChannel !== 'string' || !workerChannel.startsWith(prefix)) return;
    const workerId = workerChannel.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerId)) return;
    closeWorkerBridge(workerChannel);
    workerBridges.set(workerChannel, { calls: new Map() });
    window.postMessage({ channel, type: 'worker-connected', workerChannel }, window.location.origin);
  }

  function relayWorkerMessage(workerChannel, message) {
    const bridge = workerBridges.get(workerChannel);
    if (!bridge) return;
    if (message?.type === 'request') {
      if (bridge.calls.has(message.id)) return;
      const port = connectProviderRelay();
      if (!port) {
        routeNative(message, workerChannel);
        return;
      }
      bridge.calls.set(message.id, port);
      try {
        port.onMessage.addListener((reply) => {
          if (bridge.calls.get(message.id) !== port) return;
          window.postMessage({ channel, direction: 'worker-extension', workerChannel, ...reply }, window.location.origin);
          if (['route', 'response-end', 'error'].includes(reply.type)) {
            bridge.calls.delete(message.id);
            disconnectProviderPort(port);
          }
        });
        port.onDisconnect.addListener(() => {
          if (bridge.calls.get(message.id) !== port) return;
          bridge.calls.delete(message.id);
          window.postMessage({
            channel,
            direction: 'worker-extension',
            workerChannel,
            type: 'error',
            id: message.id,
          }, window.location.origin);
        });
      } catch {
        bridge.calls.delete(message.id);
        disconnectProviderPort(port);
        routeNative(message, workerChannel);
        return;
      }
      if (!postProviderMessage(port, message)) {
        bridge.calls.delete(message.id);
        disconnectProviderPort(port);
        routeNative(message, workerChannel);
      }
      return;
    }
    const port = bridge.calls.get(message?.id);
    if (!port) return;
    if (message.type === 'ack') postProviderMessage(port, message);
    if (message.type === 'cancel') {
      postProviderMessage(port, message);
      bridge.calls.delete(message.id);
      disconnectProviderPort(port);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== channel || ['extension', 'worker-extension'].includes(message.direction)) return;

    if (message.type === 'worker-connect') {
      connectWorkerBridge(message.workerChannel);
      return;
    }
    if (message.type === 'worker-disconnect') {
      closeWorkerBridge(message.workerChannel);
      return;
    }
    if (message.direction === 'worker') {
      if (!workerBridges.has(message.workerChannel)) connectWorkerBridge(message.workerChannel);
      relayWorkerMessage(message.workerChannel, message);
      return;
    }

    if (message.type === 'request') {
      const port = connectProviderRelay();
      if (!port) {
        routeNative(message);
        return;
      }
      calls.set(message.id, port);
      try {
        port.onMessage.addListener((reply) => {
          window.postMessage({ channel, direction: 'extension', ...reply }, window.location.origin);
          if (['route', 'response-end', 'error'].includes(reply.type)) {
            calls.delete(message.id);
            disconnectProviderPort(port);
          }
        });
        port.onDisconnect.addListener(() => {
          if (!calls.delete(message.id)) return;
          window.postMessage({
            channel,
            direction: 'extension',
            type: 'error',
            id: message.id,
          }, window.location.origin);
        });
      } catch {
          calls.delete(message.id);
        disconnectProviderPort(port);
        routeNative(message);
        return;
      }
      if (!postProviderMessage(port, message)) {
        calls.delete(message.id);
        disconnectProviderPort(port);
        routeNative(message);
      }
      return;
    }

    const port = calls.get(message.id);
    if (!port) return;
    if (message.type === 'ack') postProviderMessage(port, message);
    if (message.type === 'cancel') {
      postProviderMessage(port, message);
      calls.delete(message.id);
      disconnectProviderPort(port);
    }
  });
})();