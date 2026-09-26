(() => {
  const channel = 'browser-ai-connector-v1';
  const calls = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== channel || message.direction === 'extension') return;

    if (message.type === 'request') {
      const port = chrome.runtime.connect({ name: 'openai-relay' });
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