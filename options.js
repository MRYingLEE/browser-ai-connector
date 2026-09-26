const form = document.querySelector('#assignment-form');
const providerInput = document.querySelector('#provider');
const originInput = document.querySelector('#origin');
const keyInput = document.querySelector('#api-key');
const keyLabel = document.querySelector('#api-key-label');
const providerHelp = document.querySelector('#provider-help');
const customFields = document.querySelector('#custom-fields');
const customName = document.querySelector('#custom-name');
const customEndpoint = document.querySelector('#custom-endpoint');
const customAuthMode = document.querySelector('#custom-auth-mode');
const customHeaderFields = document.querySelector('#custom-header-fields');
const customHeaderName = document.querySelector('#custom-header-name');
const customHeaderPrefix = document.querySelector('#custom-header-prefix');
const customQueryFields = document.querySelector('#custom-query-fields');
const customQueryParam = document.querySelector('#custom-query-param');
const azureFields = document.querySelector('#azure-fields');
const azureEndpoint = document.querySelector('#azure-endpoint');
const azureAuth = document.querySelector('#azure-auth');
const entraFields = document.querySelector('#entra-fields');
const tenantId = document.querySelector('#tenant-id');
const clientId = document.querySelector('#client-id');
const clientSecret = document.querySelector('#client-secret');
const status = document.querySelector('#status');
const assignments = document.querySelector('#assignments');
const requestLogs = document.querySelector('#request-logs');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = '';
  try {
    if (providerInput.value === 'custom') await requestCustomHostPermission(customEndpoint.value);
    await chrome.runtime.sendMessage({
      type: 'save-assignment',
      provider: providerInput.value,
      providerName: customName.value,
      origin: originInput.value,
      apiKey: keyInput.value,
      endpoint: providerInput.value === 'custom' ? customEndpoint.value : azureEndpoint.value,
      customAuthMode: customAuthMode.value,
      headerName: customHeaderName.value,
      headerPrefix: customHeaderPrefix.value,
      queryParam: customQueryParam.value,
      authMode: azureAuth.value,
      tenantId: tenantId.value,
      clientId: clientId.value,
      clientSecret: clientSecret.value,
    });
    keyInput.value = '';
    clientSecret.value = '';
    status.textContent = 'Assignment saved.';
    await refreshAssignments();
  } catch (error) {
    status.textContent = error.message;
  }
});

providerInput.addEventListener('change', updateProviderFields);
azureAuth.addEventListener('change', updateProviderFields);
customAuthMode.addEventListener('change', updateProviderFields);

assignments.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  try {
    await chrome.runtime.sendMessage({
      type: button.dataset.action,
      provider: button.closest('[data-provider]').dataset.provider,
      origin: button.closest('[data-origin]').dataset.origin,
    });
    await refreshAssignments();
  } catch (error) {
    status.textContent = error.message;
  }
});

async function refreshAssignments() {
  const entries = await chrome.runtime.sendMessage({ type: 'list-assignments' });
  assignments.replaceChildren(...entries.map((entry) => createAssignmentRow(entry)));
}

async function refreshRequestLogs() {
  const entries = await chrome.runtime.sendMessage({ type: 'list-request-logs' });
  if (entries.length === 0) {
    const emptyState = document.createElement('li');
    emptyState.className = 'help';
    emptyState.textContent = 'No supported requests yet.';
    requestLogs.replaceChildren(emptyState);
    return;
  }
  requestLogs.replaceChildren(...entries.map((entry) => createRequestLogRow(entry)));
}

function createRequestLogRow(entry) {
  const row = document.createElement('li');
  row.className = 'request-log';

  const providerName = entry.providerName ?? ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google AI', agnes: 'Agnes', azure: 'Azure OpenAI' }[entry.provider]);
  const request = document.createElement('strong');
  request.textContent = `${providerName} · ${entry.method} ${entry.url}`;
  const origin = document.createElement('span');
  origin.textContent = entry.origin;
  const timestamp = document.createElement('time');
  timestamp.dateTime = entry.timestamp;
  timestamp.textContent = new Date(entry.timestamp).toLocaleString();
  const logStatus = document.createElement('span');
  logStatus.className = 'request-log-status';
  logStatus.textContent = entry.status;
  row.append(request, origin, timestamp, logStatus);
  return row;
}

function createAssignmentRow(entry) {
  const row = document.createElement('article');
  row.className = 'assignment';
  row.dataset.origin = entry.origin;
  row.dataset.provider = entry.provider;

  const details = document.createElement('div');
  const origin = document.createElement('strong');
  const providerName = entry.providerName ?? ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google AI', agnes: 'Agnes', azure: 'Azure OpenAI' }[entry.provider]);
  origin.textContent = `${providerName} · ${entry.origin}`;
  details.append(origin);
  if (entry.endpoint) {
    const endpoint = document.createElement('span');
    const authLabel = entry.authMode === 'entra'
      ? 'Microsoft Entra ID'
      : entry.customAuthMode === 'query'
        ? `query parameter: ${entry.queryParam}`
        : entry.customAuthMode === 'header'
          ? `header: ${entry.headerName}`
          : entry.provider === 'azure' ? 'API key' : 'Bearer token';
    endpoint.textContent = `${entry.endpoint} · ${authLabel}`;
    details.append(endpoint);
  }
  const keyStatus = document.createElement('span');
  keyStatus.textContent = entry.authMode === 'entra'
    ? entry.hasKey ? 'Client secret stored locally' : 'No client secret stored'
    : entry.hasKey ? 'Key stored locally' : 'No key stored';
  details.append(keyStatus);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (entry.hasKey) {
    actions.append(actionButton('remove-key', entry.authMode === 'entra' ? 'Remove client secret' : 'Remove key'));
  }
  actions.append(actionButton('remove-assignment', 'Remove assignment'));
  row.append(details, actions);
  return row;
}

function actionButton(action, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function updateProviderFields() {
  const provider = providerInput.value;
  const isAzure = provider === 'azure';
  const isCustom = provider === 'custom';
  const isEntra = isAzure && azureAuth.value === 'entra';
  const customMode = customAuthMode.value;
  azureFields.hidden = !isAzure;
  entraFields.hidden = !isEntra;
  customFields.hidden = !isCustom;
  customHeaderFields.hidden = !isCustom || customMode !== 'header';
  customQueryFields.hidden = !isCustom || customMode !== 'query';
  keyInput.hidden = isEntra;
  keyLabel.hidden = isEntra;
  azureEndpoint.required = isAzure;
  customName.required = isCustom;
  customEndpoint.required = isCustom;
  customHeaderName.required = isCustom && customMode === 'header';
  customQueryParam.required = isCustom && customMode === 'query';
  keyInput.required = !isEntra;
  tenantId.required = isEntra;
  clientId.required = isEntra;
  clientSecret.required = isEntra;
  keyLabel.textContent = isCustom ? 'Provider API key' : `${providerInput.selectedOptions[0].textContent} API key`;
  providerHelp.textContent = {
    openai: 'Routes OpenAI text-generation requests to api.openai.com. Store the API key issued by OpenAI.',
    anthropic: 'Routes Anthropic Messages API requests to api.anthropic.com. Store the API key issued by Anthropic.',
    google: 'Routes Google AI generateContent requests to generativelanguage.googleapis.com. The registered key is sent in x-goog-api-key.',
    agnes: 'Agnes uses an OpenAI-compatible API. Use https://apihub.agnes-ai.com/v1 in your application, model agnes-2.5-flash, and an Agnes API key.',
    azure: 'Supports /openai/deployments/DEPLOYMENT and /openai/v1 requests. Deployment, model, and api-version are preserved; the resource host is routed to the URL below.',
    custom: 'Configure any provider whose API accepts a static key in a bearer header, a chosen header, or a query parameter. The provider SDK must still use its native API format.',
  }[provider];
}

async function requestCustomHostPermission(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid provider API base URL.');
  }
  const originPattern = `${url.protocol}//${url.hostname}/*`;
  const permission = { origins: [originPattern] };
  if (await chrome.permissions.contains(permission)) return;
  if (!await chrome.permissions.request(permission)) throw new Error(`Host access was not granted for ${url.hostname}.`);
}

form.dataset.ready = 'true';
updateProviderFields();

refreshAssignments().catch((error) => {
  status.textContent = error.message;
});
refreshRequestLogs().catch(() => {});
setInterval(() => refreshRequestLogs().catch(() => {}), 1000);