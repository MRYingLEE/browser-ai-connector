(() => {
  const channel = 'browser-ai-connector-v1';
  const nativeFetch = window.fetch.bind(window);
  const pending = new Map();
  const workerBridges = new Map();

  function createWorker(workerUrl, options) {
    const targetUrl = new URL(workerUrl, window.location.href);
    if (targetUrl.origin !== window.location.origin) {
      throw new DOMException('Integrated workers must use the page origin.', 'SecurityError');
    }

    const workerChannel = `${channel}-worker-${crypto.randomUUID()}`;
    const bridgeChannel = new BroadcastChannel(workerChannel);
    const bridge = { channel: bridgeChannel, connectRequested: false, connected: false };
    const queuedWorkerMessages = [];
    let workerScriptReady = false;
    let postToWorker;
    function flushWorkerMessages() {
      if (!workerScriptReady || !postToWorker) return;
      while (queuedWorkerMessages.length) postToWorker(...queuedWorkerMessages.shift());
    }
    workerBridges.set(workerChannel, bridge);
    bridgeChannel.addEventListener('message', ({ data: message }) => {
      if (message?.type === 'ready') {
        if (bridge.connectRequested) return;
        bridge.connectRequested = true;
        window.postMessage({ channel, type: 'worker-connect', workerChannel }, window.location.origin);
        return;
      }
      if (message?.type === 'disconnect') {
        window.postMessage({ channel, type: 'worker-disconnect', workerChannel }, window.location.origin);
        workerBridges.delete(workerChannel);
        bridge.channel.close();
        return;
      }
      if (message?.type === 'worker-script-ready') {
        workerScriptReady = true;
        flushWorkerMessages();
        return;
      }
      window.postMessage({ channel, direction: 'worker', workerChannel, ...message }, window.location.origin);
    });
    const bootstrap = `(() => {
      const channel = new BroadcastChannel(${JSON.stringify(workerChannel)});
      const nativeFetch = self.fetch.bind(self);
      const pending = new Map();
      let relayReady = false;
      let resolveRelayReady;
      let readyTimer;
      const relayHandshake = new Promise((resolve) => {
        resolveRelayReady = resolve;
        readyTimer = setTimeout(() => resolve(false), 1000);
      });

      function supportedRequest(url) {
        return (url.protocol === 'https:' && url.hostname === 'api.openai.com' && url.pathname.startsWith('/v1/'))
          || (url.protocol === 'https:' && url.hostname === 'api.anthropic.com' && url.pathname === '/v1/messages')
          || (url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com'
            && /^\\/v1(?:beta)?\\/models\\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(url.pathname));
      }

      function finish(id) {
        const request = pending.get(id);
        if (!request) return;
        request.removeAbortListener();
        pending.delete(id);
      }

      channel.addEventListener('message', ({ data: message }) => {
        if (message?.type === 'ready') {
          if (!relayReady) {
            relayReady = true;
            clearTimeout(readyTimer);
            resolveRelayReady(true);
          }
          return;
        }
        const request = pending.get(message?.id);
        if (!request) return;
        if (message.type === 'route') {
          pending.delete(message.id);
          request.removeAbortListener();
          if (message.route === 'native') request.resolve(nativeFetch(request.nativeRequest));
          else request.reject(new TypeError('The configured provider credential is unavailable.'));
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
              channel.postMessage({ type: 'cancel', id: message.id });
              finish(message.id);
            },
          });
          request.resolve(new Response(stream, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }));
          if (noBody) channel.postMessage({ type: 'ack', id: message.id });
          return;
        }
        if (message.type === 'response-chunk') {
          request.controller?.enqueue(new Uint8Array(message.chunk));
          channel.postMessage({ type: 'ack', id: message.id });
          return;
        }
        if (message.type === 'response-end') {
          request.controller?.close();
          finish(message.id);
          return;
        }
        if (message.type === 'error') {
          request.controller?.error(new TypeError('The provider request could not be completed.'));
          request.reject(new TypeError('The provider request could not be completed.'));
          finish(message.id);
        }
      });

      channel.postMessage({ type: 'ready' });
      self.fetch = function browserAiConnectorWorkerFetch(input, init) {
        let request;
        try {
          request = new Request(input, init);
        } catch (error) {
          return Promise.reject(error);
        }
        const requestUrl = new URL(request.url);
        if (!relayReady || !supportedRequest(requestUrl)) return nativeFetch(request);

        const id = crypto.randomUUID();
        let resolveRequest;
        let rejectRequest;
        const result = new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
        const relayRequest = {
          resolve: resolveRequest,
          reject: rejectRequest,
          nativeRequest: request.clone(),
          controller: null,
          removeAbortListener: () => {},
        };
        pending.set(id, relayRequest);
        const abort = () => {
          channel.postMessage({ type: 'cancel', id });
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
            const body = ['GET', 'HEAD'].includes(request.method)
              ? []
              : Array.from(new Uint8Array(await request.clone().arrayBuffer()));
            if (!pending.has(id) || request.signal.aborted) return;
            channel.postMessage({
              type: 'request',
              id,
              url: request.url,
              method: request.method,
              headers: [...request.headers],
              body,
            });
          } catch {
            rejectRequest(new TypeError('The provider request could not be prepared.'));
            finish(id);
          }
        })();
        return result;
      };

      const disconnect = () => channel.postMessage({ type: 'disconnect' });
      self.addEventListener('error', disconnect);
      const nativeClose = self.close.bind(self);
      self.close = () => {
        disconnect();
        nativeClose();
      };

      const workerUrl = ${JSON.stringify(targetUrl.href)};
      relayHandshake.then(() => {
        try {
          if (${JSON.stringify(options?.type === 'module')}) {
            import(workerUrl)
              .then(() => channel.postMessage({ type: 'worker-script-ready' }))
              .catch((error) => self.postMessage({ workerBootstrapError: error.message }));
          } else {
            importScripts(workerUrl);
            channel.postMessage({ type: 'worker-script-ready' });
          }
        } catch (error) {
          self.postMessage({ workerBootstrapError: error.message });
        }
      });
    })();`;
    const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
    let worker;
    try {
      worker = new Worker(blobUrl, options);
    } catch (error) {
      workerBridges.delete(workerChannel);
      bridgeChannel.close();
      URL.revokeObjectURL(blobUrl);
      throw error;
    }
    const nativeTerminate = worker.terminate.bind(worker);
    postToWorker = worker.postMessage.bind(worker);
    worker.postMessage = (...arguments_) => {
      if (workerScriptReady) postToWorker(...arguments_);
      else queuedWorkerMessages.push(arguments_);
    };
    flushWorkerMessages();
    worker.terminate = () => {
      window.postMessage({ channel, type: 'worker-disconnect', workerChannel }, window.location.origin);
      workerBridges.delete(workerChannel);
      bridgeChannel.close();
      URL.revokeObjectURL(blobUrl);
      nativeTerminate();
    };
    worker.addEventListener('error', () => URL.revokeObjectURL(blobUrl), { once: true });
    return worker;
  }

  function send(message) {
    window.postMessage({ channel, ...message }, window.location.origin);
  }

  function handleRelayMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== channel) return;
    if (message.type === 'worker-connected') {
      const bridge = workerBridges.get(message.workerChannel);
      if (!bridge || bridge.connected) return;
      bridge.connected = true;
      bridge.channel.postMessage({ type: 'ready' });
      return;
    }
    if (message.direction === 'worker-extension') {
      const bridge = workerBridges.get(message.workerChannel);
      if (!bridge) return;
      const reply = { ...message };
      delete reply.channel;
      delete reply.direction;
      delete reply.workerChannel;
      bridge.channel.postMessage(reply);
      return;
    }
    if (message.direction !== 'extension') return;
    const request = pending.get(message.id);
    if (!request) return;

    if (message.type === 'route') {
      pending.delete(message.id);
      request.removeAbortListener();
      if (message.route === 'native') {
        request.resolve(nativeFetch(request.nativeRequest));
      } else {
        request.reject(new TypeError('The configured provider credential is unavailable.'));
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
      request.controller?.error(new TypeError('The provider request could not be completed.'));
      request.reject(new TypeError('The provider request could not be completed.'));
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
  window.BrowserAIConnector = Object.freeze({ createWorker });

  window.fetch = function browserAiConnectorFetch(input, init) {
    let request;
    try {
      request = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestUrl = new URL(request.url);
    const isOpenAiRequest = requestUrl.protocol === 'https:'
      && requestUrl.hostname === 'api.openai.com'
      && requestUrl.pathname.startsWith('/v1/');
    const isAnthropicRequest = requestUrl.protocol === 'https:'
      && requestUrl.hostname === 'api.anthropic.com'
      && requestUrl.pathname === '/v1/messages';
    const isGoogleRequest = requestUrl.protocol === 'https:'
      && requestUrl.hostname === 'generativelanguage.googleapis.com'
      && /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(requestUrl.pathname);
    if (!isOpenAiRequest && !isAnthropicRequest && !isGoogleRequest) {
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
        rejectRequest(new TypeError('The provider request could not be prepared.'));
        finish(id);
      }
    })();

    return result;
  };
})();