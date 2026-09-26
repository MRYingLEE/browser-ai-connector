(() => {
  const channel = 'browser-ai-connector-v1';
  const calls = new Map();
  const workerBridges = new Map();

  function closeWorkerBridge(workerChannel) {
    const bridge = workerBridges.get(workerChannel);
    if (!bridge) return;
    workerBridges.delete(workerChannel);
    for (const [id, port] of bridge.calls) {
      port.postMessage({ type: 'cancel', id });
      port.disconnect();
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
      const port = chrome.runtime.connect({ name: 'provider-relay' });
      bridge.calls.set(message.id, port);
      port.onMessage.addListener((reply) => {
        if (bridge.calls.get(message.id) !== port) return;
        window.postMessage({ channel, direction: 'worker-extension', workerChannel, ...reply }, window.location.origin);
        if (['route', 'response-end', 'error'].includes(reply.type)) {
          bridge.calls.delete(message.id);
          port.disconnect();
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
      port.postMessage(message);
      return;
    }
    const port = bridge.calls.get(message?.id);
    if (!port) return;
    if (message.type === 'ack') port.postMessage(message);
    if (message.type === 'cancel') {
      port.postMessage(message);
      bridge.calls.delete(message.id);
      port.disconnect();
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
      relayWorkerMessage(message.workerChannel, message);
      return;
    }

    if (message.type === 'request') {
      const port = chrome.runtime.connect({ name: 'provider-relay' });
      calls.set(message.id, port);
      port.onMessage.addListener((reply) => {
        window.postMessage({ channel, direction: 'extension', ...reply }, window.location.origin);
        if (['route', 'response-end', 'error'].includes(reply.type)) {
          calls.delete(message.id);
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => calls.delete(message.id));
      port.postMessage(message);
      return;
    }

    const port = calls.get(message.id);
    if (!port) return;
    if (message.type === 'ack') port.postMessage(message);
    if (message.type === 'cancel') {
      port.postMessage(message);
      calls.delete(message.id);
      port.disconnect();
    }
  });
})();