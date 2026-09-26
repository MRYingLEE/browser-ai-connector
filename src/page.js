(() => {
  const channel = 'browser-ai-connector-v1';
  const nativeFetch = window.fetch.bind(window);
  const pending = new Map();

  function send(message) {
    window.postMessage({ channel, ...message }, window.location.origin);
  }

  function handleRelayMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== channel || message.direction !== 'extension') return;
    const request = pending.get(message.id);
    if (!request) return;

    if (message.type === 'route') {
      pending.delete(message.id);
      request.removeAbortListener();
      if (message.route === 'native') {
        request.resolve(nativeFetch(request.nativeRequest));
      } else {
        request.reject(new TypeError('The configured OpenAI credential is unavailable.'));
      }
      return;
    }

    if (message.type === 'response-start') {
      request.started = true;
      const noBody = [204, 205, 304].includes(message.status);
      const stream = noBody ? null : new ReadableStream({
        start(controller) {
          request.controller = controller;
        },
        cancel() {
          send({ type: 'cancel', id: message.id });
          finish(message.id);
        },
      });
      request.resolve(new Response(stream, {
        status: message.status,
        statusText: message.statusText,
        headers: message.headers,
      }));
      if (noBody) send({ type: 'ack', id: message.id });
      return;
    }

    if (message.type === 'response-chunk') {
      request.controller?.enqueue(new Uint8Array(message.chunk));
      send({ type: 'ack', id: message.id });
      return;
    }

    if (message.type === 'response-end') {
      request.controller?.close();
      finish(message.id);
      return;
    }

    if (message.type === 'error') {
      request.controller?.error(new TypeError('The OpenAI request could not be completed.'));
      request.reject(new TypeError('The OpenAI request could not be completed.'));
      finish(message.id);
    }
  }

  function finish(id) {
    const request = pending.get(id);
    if (!request) return;
    request.removeAbortListener();
    pending.delete(id);
  }

  window.addEventListener('message', handleRelayMessage);

  window.fetch = function browserAiConnectorFetch(input, init) {
    let request;
    try {
      request = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== 'https:' || requestUrl.hostname !== 'api.openai.com' || !requestUrl.pathname.startsWith('/v1/')) {
      return nativeFetch(request);
    }

    const id = crypto.randomUUID();
    const nativeRequest = request.clone();
    let resolveRequest;
    let rejectRequest;
    const result = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const relayRequest = {
      resolve: resolveRequest,
      reject: rejectRequest,
      nativeRequest,
      started: false,
      controller: null,
      removeAbortListener: () => {},
    };
    pending.set(id, relayRequest);

    const abort = () => {
      send({ type: 'cancel', id });
      relayRequest.controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
      rejectRequest(new DOMException('The operation was aborted.', 'AbortError'));
      finish(id);
    };
    if (request.signal.aborted) {
      abort();
      return result;
    }
    request.signal.addEventListener('abort', abort, { once: true });
    relayRequest.removeAbortListener = () => request.signal.removeEventListener('abort', abort);

    (async () => {
      try {
        const body = ['GET', 'HEAD'].includes(request.method) ? [] : Array.from(new Uint8Array(await request.arrayBuffer()));
        if (!pending.has(id) || request.signal.aborted) return;
        send({
          type: 'request',
          id,
          url: request.url,
          method: request.method,
          headers: [...request.headers],
          body,
        });
      } catch {
        rejectRequest(new TypeError('The OpenAI request could not be prepared.'));
        finish(id);
      }
    })();

    return result;
  };
})();