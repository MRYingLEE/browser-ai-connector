const form = document.querySelector('#assignment-form');
const providerInput = document.querySelector('#provider');
const originInput = document.querySelector('#origin');
const keyInput = document.querySelector('#api-key');
const keyLabel = document.querySelector('#api-key-label');
const status = document.querySelector('#status');
const assignments = document.querySelector('#assignments');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = '';
  try {
    await chrome.runtime.sendMessage({
      type: 'save-assignment',
      provider: providerInput.value,
      origin: originInput.value,
      apiKey: keyInput.value,
    });
    keyInput.value = '';
    status.textContent = 'Assignment saved.';
    await refreshAssignments();
  } catch (error) {
    status.textContent = error.message;
  }
});

providerInput.addEventListener('change', () => {
  keyLabel.textContent = `${providerInput.selectedOptions[0].textContent} API key`;
});

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

function createAssignmentRow(entry) {
  const row = document.createElement('article');
  row.className = 'assignment';
  row.dataset.origin = entry.origin;
  row.dataset.provider = entry.provider;

  const details = document.createElement('div');
  const origin = document.createElement('strong');
  origin.textContent = `${entry.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · ${entry.origin}`;
  const keyStatus = document.createElement('span');
  keyStatus.textContent = entry.hasKey ? 'Key stored locally' : 'No key stored';
  details.append(origin, keyStatus);

  const actions = document.createElement('div');
  actions.className = 'actions';
  if (entry.hasKey) {
    actions.append(actionButton('remove-key', 'Remove key'));
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

form.dataset.ready = 'true';

refreshAssignments().catch((error) => {
  status.textContent = error.message;
});