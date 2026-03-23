const state = {
  user: null,
  conversations: [],
  activeConversationId: null,
  messages: [],
  pollHandle: null,
};

const el = {
  authView: document.getElementById('auth-view'),
  appView: document.getElementById('app-view'),
  loginForm: document.getElementById('login-form'),
  registerForm: document.getElementById('register-form'),
  authError: document.getElementById('auth-error'),
  tabLogin: document.getElementById('tab-login'),
  tabRegister: document.getElementById('tab-register'),
  meName: document.getElementById('me-name'),
  meEmail: document.getElementById('me-email'),
  conversationList: document.getElementById('conversation-list'),
  newChatForm: document.getElementById('new-chat-form'),
  emptyState: document.getElementById('empty-state'),
  chatPanel: document.getElementById('chat-panel'),
  chatTitle: document.getElementById('chat-title'),
  chatSubtitle: document.getElementById('chat-subtitle'),
  messageList: document.getElementById('message-list'),
  composerForm: document.getElementById('composer-form'),
  messageInput: document.getElementById('message-input'),
  fileInput: document.getElementById('file-input'),
  logoutButton: document.getElementById('logout-button'),
  conversationTpl: document.getElementById('conversation-item-template'),
  messageTpl: document.getElementById('message-template'),
};

boot();

async function boot() {
  bindEvents();
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    showApp();
    await refreshConversations();
  } catch {
    showAuth();
  }
}

function bindEvents() {
  el.tabLogin.addEventListener('click', () => switchTab('login'));
  el.tabRegister.addEventListener('click', () => switchTab('register'));

  el.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleAuth('/api/auth/login', new FormData(el.loginForm));
  });

  el.registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleAuth('/api/auth/register', new FormData(el.registerForm));
  });

  el.newChatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(el.newChatForm);
    const email = String(data.get('email') || '').trim();
    if (!email) return;
    try {
      const result = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ email }) });
      el.newChatForm.reset();
      await refreshConversations();
      if (result.conversationId) {
        openConversation(result.conversationId);
      }
    } catch (error) {
      alert(error.message);
    }
  });

  el.composerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.activeConversationId) return;
    const text = el.messageInput.value.trim();
    const file = el.fileInput.files[0];

    try {
      if (file) {
        const form = new FormData();
        form.append('file', file);
        if (text) form.append('caption', text);
        await api(`/api/conversations/${state.activeConversationId}/upload`, { method: 'POST', body: form, isForm: true });
        el.fileInput.value = '';
        el.messageInput.value = '';
      } else if (text) {
        await api(`/api/conversations/${state.activeConversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: text }),
        });
        el.messageInput.value = '';
      }
      await refreshMessages();
      await refreshConversations();
    } catch (error) {
      alert(error.message);
    }
  });

  el.logoutButton.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    stopPolling();
    state.user = null;
    state.activeConversationId = null;
    state.messages = [];
    showAuth();
  });
}

async function handleAuth(endpoint, formData) {
  hideAuthError();
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    state.user = result.user;
    showApp();
    await refreshConversations();
  } catch (error) {
    showAuthError(error.message);
  }
}

function switchTab(mode) {
  const isLogin = mode === 'login';
  el.tabLogin.classList.toggle('active', isLogin);
  el.tabRegister.classList.toggle('active', !isLogin);
  el.loginForm.classList.toggle('hidden', !isLogin);
  el.registerForm.classList.toggle('hidden', isLogin);
  hideAuthError();
}

function showAuth() {
  el.authView.classList.remove('hidden');
  el.appView.classList.add('hidden');
  switchTab('login');
}

function showApp() {
  el.authView.classList.add('hidden');
  el.appView.classList.remove('hidden');
  el.meName.textContent = state.user.display_name;
  el.meEmail.textContent = state.user.email;
}

function showAuthError(message) {
  el.authError.textContent = message;
  el.authError.classList.remove('hidden');
}

function hideAuthError() {
  el.authError.textContent = '';
  el.authError.classList.add('hidden');
}

async function refreshConversations() {
  const result = await api('/api/conversations');
  state.conversations = result.conversations || [];
  renderConversations();
  if (!state.activeConversationId && state.conversations.length) {
    openConversation(state.conversations[0].id);
  }
}

function renderConversations() {
  el.conversationList.innerHTML = '';
  for (const conversation of state.conversations) {
    const node = el.conversationTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.conversation-name').textContent = conversation.other_display_name || conversation.other_email;
    node.querySelector('.conversation-snippet').textContent = conversation.last_message_body || 'No messages yet';
    node.classList.toggle('active', conversation.id === state.activeConversationId);
    node.addEventListener('click', () => openConversation(conversation.id));
    el.conversationList.appendChild(node);
  }
}

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  renderConversations();
  const conversation = state.conversations.find((item) => item.id === conversationId);
  el.emptyState.classList.add('hidden');
  el.chatPanel.classList.remove('hidden');
  el.chatTitle.textContent = conversation?.other_display_name || 'Conversation';
  el.chatSubtitle.textContent = conversation?.other_email || '';
  await refreshMessages();
  startPolling();
}

async function refreshMessages() {
  if (!state.activeConversationId) return;
  const result = await api(`/api/conversations/${state.activeConversationId}/messages`);
  state.messages = result.messages || [];
  renderMessages();
  const last = state.messages[state.messages.length - 1];
  if (last) {
    await api(`/api/conversations/${state.activeConversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId: last.id }),
    }).catch(() => {});
  }
}

function renderMessages() {
  el.messageList.innerHTML = '';
  for (const message of state.messages) {
    const node = el.messageTpl.content.firstElementChild.cloneNode(true);
    node.classList.toggle('mine', message.sender_id === state.user.id);
    node.querySelector('.message-meta').textContent = `${message.sender_id === state.user.id ? 'You' : 'Client'} • ${formatTime(message.created_at)}`;
    node.querySelector('.message-body').textContent = message.body || '';
    const zone = node.querySelector('.attachment-zone');
    if (message.attachment) {
      if ((message.attachment.mime_type || '').startsWith('image/')) {
        const img = document.createElement('img');
        img.src = message.attachment.url;
        img.alt = message.attachment.original_name;
        zone.appendChild(img);
      }
      const link = document.createElement('a');
      link.href = message.attachment.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `Open ${message.attachment.original_name}`;
      zone.appendChild(link);
    }
    el.messageList.appendChild(node);
  }
  el.messageList.scrollTop = el.messageList.scrollHeight;
}

function startPolling() {
  stopPolling();
  state.pollHandle = setInterval(async () => {
    if (!state.activeConversationId) return;
    try {
      await refreshMessages();
      await refreshConversations();
    } catch {}
  }, 3000);
}

function stopPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

function formatTime(value) {
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

async function api(url, options = {}) {
  const init = { method: 'GET', credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (!options.isForm && options.body && !init.headers['content-type']) {
    init.headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
