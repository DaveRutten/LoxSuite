// The AI Assistant's floating widget (see partials/ai-chat-widget.ejs) — replaces the old
// full-page /ai-chat nav item entirely. Three views inside one panel: the conversation list
// (default), the new-conversation form (Miniserver picker), and a conversation's own thread. Same
// fetch()+ReadableStream streaming approach the old page's public/ai-chat.js used for a turn's
// reply — the browser's own streaming-fetch engine, not polling or a new SSE/WebSocket connection.
(function () {
  var root = document.getElementById('ai-chat-widget');
  if (!root) return;

  var launcher = document.getElementById('ai-chat-launcher');
  var launcherBadge = document.getElementById('ai-chat-launcher-badge');
  var panel = document.getElementById('ai-chat-panel');
  var backBtn = document.getElementById('ai-chat-widget-back');
  var closeBtn = document.getElementById('ai-chat-widget-close');
  var newBtn = document.getElementById('ai-chat-widget-new');

  var listView = document.getElementById('ai-chat-widget-list-view');
  var listItemsEl = document.getElementById('ai-chat-widget-list-items');
  var threadView = document.getElementById('ai-chat-widget-thread-view');
  var messagesEl = document.getElementById('ai-chat-widget-messages');
  var composer = document.getElementById('ai-chat-widget-composer');
  var newForm = document.getElementById('ai-chat-widget-new-form');
  var miniserverSelect = document.getElementById('ai-chat-widget-miniserver-select');
  var createBtn = document.getElementById('ai-chat-widget-new-create');
  var clearAllBtn = document.getElementById('ai-chat-widget-clear-all');

  var loaded = false; // whether /list.json has been fetched at least once this page load
  var currentConversationId = null;

  // Conversation ids with a finished reply the user hasn't actually seen yet — the panel being
  // closed, or open on a DIFFERENT conversation, when a streamed reply completes (see the composer
  // submit handler below). Navigating to a different page instead already gets a real Notification
  // Center bell entry (routes/aiChat.js's own clientWentAway check) since that's a much bigger
  // interruption; this is the lighter-weight same-page case that check can't see, since the
  // underlying fetch keeps running (and res.write() keeps succeeding) even with the panel closed.
  var unreadConversationIds = {};

  function markUnread(id) {
    unreadConversationIds[id] = true;
    launcherBadge.hidden = false;
  }

  function markRead(id) {
    delete unreadConversationIds[id];
    launcherBadge.hidden = !Object.keys(unreadConversationIds).length;
  }

  // Personal display state — persisted the same way theme/help-drawer-width/panel-hints-hidden
  // already are (plain localStorage, not app data) — so navigating to a different page (a full
  // reload in this app, not an SPA route) doesn't reset an open panel back to closed, or a thread
  // you were reading back to the conversation list.
  var OPEN_KEY = 'aiChatWidgetOpen';
  var CONVERSATION_KEY = 'aiChatWidgetConversationId';

  function showView(view) {
    listView.hidden = view !== 'list';
    threadView.hidden = view !== 'thread';
    newForm.hidden = view !== 'new';
    backBtn.hidden = view === 'list';
    newBtn.hidden = view !== 'list';
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderList(conversations) {
    clearAllBtn.hidden = !conversations.length;
    if (!conversations.length) {
      listItemsEl.innerHTML = '<p class="hint ai-chat-widget-list-empty">No conversations yet — tap + to start one.</p>';
      return;
    }
    listItemsEl.innerHTML = conversations.map(function (c) {
      return '<div class="ai-chat-widget-list-row">'
        + '<button type="button" class="ai-chat-widget-list-item" data-conversation-id="' + c.id + '">'
        + escapeHtml(c.title || 'New conversation') + '</button>'
        + '<button type="button" class="icon-btn icon-btn-danger ai-chat-widget-list-delete" data-conversation-id="' + c.id + '" title="Delete conversation" aria-label="Delete conversation">'
        + '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z"/></svg>'
        + '</button></div>';
    }).join('');
  }

  // Minimal, dependency-free Markdown for assistant replies (bold/italic/code/lists/code blocks) —
  // LLM output routinely comes back with **bold**/`code`/lists, which used to show as literal
  // asterisks and backticks. Escapes first and only ever wraps the ALREADY-escaped text in tags
  // this function itself adds, so nothing the model outputs can inject real HTML/script through
  // this — same reasoning as escapeHtml() above, just with a few safe tags layered on top after.
  function renderMarkdown(text) {
    var codeBlocks = [];
    // "@@CB<n>@@" is a plain, printable placeholder that escapeHtml() output could never contain
    // verbatim by coincidence (unlike a bare number-with-spaces, which real text like "is 23
    // degrees" could actually collide with) — safer than an invisible control character, which is
    // easy to mistype/mis-paste and hard to see is even there when something goes wrong.
    var escaped = escapeHtml(text).replace(/```([\s\S]*?)```/g, function (m, code) {
      codeBlocks.push('<pre><code>' + code.replace(/^\n/, '') + '</code></pre>');
      return '@@CB' + (codeBlocks.length - 1) + '@@';
    });

    escaped = escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

    var lines = escaped.split('\n');
    var html = '';
    var i = 0;
    while (i < lines.length) {
      if (/^\s*[-*]\s+/.test(lines[i])) {
        var ulItems = '';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { ulItems += '<li>' + lines[i].replace(/^\s*[-*]\s+/, '') + '</li>'; i++; }
        html += '<ul>' + ulItems + '</ul>';
      } else if (/^\s*\d+\.\s+/.test(lines[i])) {
        var olItems = '';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { olItems += '<li>' + lines[i].replace(/^\s*\d+\.\s+/, '') + '</li>'; i++; }
        html += '<ol>' + olItems + '</ol>';
      } else if (lines[i].trim() === '') {
        i++;
      } else {
        var para = [lines[i]];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { para.push(lines[i]); i++; }
        html += '<p>' + para.join('<br>') + '</p>';
      }
    }
    return html.replace(/@@CB(\d+)@@/g, function (m, idx) { return codeBlocks[Number(idx)]; });
  }

  function renderMiniserverOptions(miniservers) {
    miniserverSelect.innerHTML = '<option value="">No Miniserver (chat only)</option>' + miniservers.map(function (ms) {
      return '<option value="' + ms.id + '">' + escapeHtml(ms.name) + '</option>';
    }).join('');
    // Pre-select the first available one rather than defaulting to "No Miniserver" — starting a
    // new chat almost always means you want it to read/control something, and with only one (or a
    // clear first) Miniserver set up for AI Assistant access, there's rarely a real choice to make.
    if (miniservers.length) miniserverSelect.value = String(miniservers[0].id);
  }

  function loadList() {
    return fetch('/ai-chat/list.json').then(function (r) { return r.json(); }).then(function (data) {
      renderList(data.conversations || []);
      renderMiniserverOptions(data.miniservers || []);
      loaded = true;
    }).catch(function () {
      listItemsEl.innerHTML = '<p class="hint ai-chat-widget-list-empty">Couldn\'t load conversations.</p>';
    });
  }

  function formatTime(when) {
    var d = when ? new Date(when) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Returns the bubble element AND its sibling time label, so callers streaming text in (the
  // composer's own submit handler) can fill in the bubble as tokens arrive and only stamp the time
  // once the reply is actually done — same "timestamp reflects when it settled, not when it
  // started" idea a real chat client uses, rather than a timestamp that's already stale the moment
  // it appears.
  // retryText is the preceding user message this failed reply was answering — passed only for
  // role 'error', to attach a Retry button (see makeRetryButton()) next to its timestamp.
  function addMessageBubble(role, text, when, retryText) {
    var wrap = document.createElement('div');
    wrap.className = 'ai-chat-widget-message ai-chat-widget-message-' + role;
    var group = document.createElement('div');
    group.className = 'ai-chat-widget-message-group';
    var bubble = document.createElement('div');
    bubble.className = 'ai-chat-widget-message-bubble';
    // The user's own typed message is shown as-is; assistant/error text comes back from an LLM
    // and routinely contains **bold**/lists/code — see renderMarkdown() above.
    if (role === 'user') bubble.textContent = text; else bubble.innerHTML = renderMarkdown(text);
    var meta = document.createElement('div');
    meta.className = 'ai-chat-widget-message-meta';
    var time = document.createElement('span');
    time.className = 'ai-chat-widget-message-time';
    time.textContent = (when === null || when === undefined) ? '' : formatTime(when);
    meta.appendChild(time);
    if (role === 'error' && retryText) meta.appendChild(makeRetryButton(retryText));
    group.appendChild(bubble);
    group.appendChild(meta);
    wrap.appendChild(group);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Handed back so callers that only find out AFTER creating the bubble that it failed (the
    // composer's own live send, below) can still add the time/retry button in after the fact.
    bubble.time = time;
    bubble.meta = meta;
    bubble.wrap = wrap;
    return bubble;
  }

  // Three bouncing dots — shown in place of the assistant bubble's text from the moment a question
  // is sent until the first token of the real reply actually arrives, so waiting (which, on local
  // CPU inference, can genuinely take a while — see the reply itself for why) still visibly LOOKS
  // like something is happening instead of a blank bubble that's indistinguishable from "sent
  // nothing yet".
  function setTyping(bubble) {
    bubble.innerHTML = '<span class="ai-chat-widget-typing"><span></span><span></span><span></span></span>';
  }

  // Re-sends `retryText` as a brand-new message rather than replacing the failed exchange in
  // place — the failed attempt stays visible above it, same as this app doesn't delete a row just
  // because a later one supersedes it anywhere else.
  function makeRetryButton(retryText) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn ai-chat-widget-retry';
    btn.title = 'Retry';
    btn.setAttribute('aria-label', 'Retry');
    btn.innerHTML = '<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    btn.addEventListener('click', function () { sendMessage(retryText); });
    return btn;
  }

  function openConversation(id) {
    currentConversationId = id;
    localStorage.setItem(CONVERSATION_KEY, id);
    markRead(id);
    messagesEl.innerHTML = '<p class="hint" style="margin:0.7rem;">Loading…</p>';
    showView('thread');
    fetch('/ai-chat/' + id + '/messages').then(function (r) { return r.json(); }).then(function (data) {
      messagesEl.innerHTML = '';
      var lastUserText = null;
      (data.messages || []).forEach(function (m) {
        if (m.role === 'user') lastUserText = m.content;
        addMessageBubble(m.status === 'error' ? 'error' : m.role, m.content, m.created_at, m.status === 'error' ? lastUserText : undefined);
      });
      var textarea = composer.querySelector('textarea');
      if (textarea) textarea.focus();
    }).catch(function () {
      messagesEl.innerHTML = '<p class="hint" style="margin:0.7rem; color:var(--danger);">Couldn\'t load this conversation.</p>';
    });
  }

  function openPanel() {
    panel.hidden = false;
    launcher.setAttribute('data-open', 'true');
    localStorage.setItem(OPEN_KEY, '1');
    if (!loaded) loadList();
    // Jump straight back into whichever conversation was last active — on a fresh page load AND
    // on a plain open/close within the same page — rather than always landing on the list. Only
    // when nothing's open yet in memory: once a conversation IS open (or the user has deliberately
    // gone Back to the list, which clears CONVERSATION_KEY below), closing and reopening within the
    // same page just reveals the same already-populated view again, no need to re-fetch it.
    if (!currentConversationId) {
      var savedConversationId = localStorage.getItem(CONVERSATION_KEY);
      if (savedConversationId) openConversation(Number(savedConversationId));
    }
  }

  function closePanel() {
    panel.hidden = true;
    launcher.setAttribute('data-open', 'false');
    localStorage.setItem(OPEN_KEY, '0');
  }

  launcher.addEventListener('click', function (e) {
    e.stopPropagation();
    if (panel.hidden) openPanel(); else closePanel();
  });

  closeBtn.addEventListener('click', closePanel);

  // Deliberately NOT closed by clicking elsewhere on the page — a click on, say, a sidebar nav
  // link IS a click outside this widget, so closing on that would both (a) close the panel while
  // navigating even though the user never asked for that, and (b) persist that closed state via
  // OPEN_KEY, so the very act of navigating anywhere else in the app would make the panel silently
  // stop reopening on later pages too. Escape still closes it — that's an explicit dismiss action,
  // not an incidental click elsewhere.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  backBtn.addEventListener('click', function () {
    currentConversationId = null;
    localStorage.removeItem(CONVERSATION_KEY);
    showView('list');
    loadList();
  });

  newBtn.addEventListener('click', function () {
    showView('new');
  });

  listItemsEl.addEventListener('click', function (e) {
    var deleteBtn = e.target.closest('.ai-chat-widget-list-delete');
    if (deleteBtn) {
      var id = Number(deleteBtn.dataset.conversationId);
      fetch('/ai-chat/' + id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () {
          if (currentConversationId === id) {
            currentConversationId = null;
            localStorage.removeItem(CONVERSATION_KEY);
            showView('list');
          }
          loadList();
        }).catch(function () {});
      return;
    }
    var item = e.target.closest('.ai-chat-widget-list-item');
    if (item) openConversation(Number(item.dataset.conversationId));
  });

  clearAllBtn.addEventListener('click', function () {
    clearAllBtn.disabled = true;
    fetch('/ai-chat/delete-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function () {
        currentConversationId = null;
        localStorage.removeItem(CONVERSATION_KEY);
        showView('list');
        return loadList();
      }).catch(function () {}).then(function () {
        clearAllBtn.disabled = false;
      });
  });

  createBtn.addEventListener('click', function () {
    createBtn.disabled = true;
    fetch('/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ miniserver_id: miniserverSelect.value }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      createBtn.disabled = false;
      messagesEl.innerHTML = '';
      openConversation(data.id);
    }).catch(function () {
      createBtn.disabled = false;
    });
  });

  // Shared by the composer's own submit handler AND every Retry button (see makeRetryButton()) —
  // sends `text` into whichever conversation is currently open.
  function sendMessage(text) {
    if (!currentConversationId) return;
    var textarea = composer.querySelector('textarea');
    var sendBtn = composer.querySelector('button[type="submit"]');
    textarea.disabled = true;
    sendBtn.disabled = true;

    addMessageBubble('user', text, new Date());
    var assistantBubble = addMessageBubble('assistant', '', null);
    setTyping(assistantBubble);
    var typing = true;
    var rawText = ''; // re-rendered through renderMarkdown() on every chunk — markdown constructs
    // like **bold** can straddle two separate stream chunks, so appending pre-rendered HTML
    // fragment-by-fragment would miss/break them; re-rendering the whole accumulated text each
    // time is cheap at this scale (a chat reply, not a document) and always structurally correct.
    var sentForConversationId = currentConversationId;

    fetch('/ai-chat/' + sentForConversationId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().then(function (data) {
          throw new Error(data.error || ('Request failed (' + resp.status + ')'));
        });
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      function read() {
        return reader.read().then(function (result) {
          if (result.done) return;
          var chunk = decoder.decode(result.value, { stream: true });
          if (!chunk) return read();
          if (typing) typing = false;
          rawText += chunk;
          assistantBubble.innerHTML = renderMarkdown(rawText);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return read();
        });
      }
      return read();
    }).then(function () {
      // The stream can still end in failure even though fetch() itself never rejected — a turn
      // that errors out AFTER the response started (see routes/aiChat.js's own catch block) writes
      // a "\n\n[Error: ...]" tail straight into the same stream rather than dropping the
      // connection, so this doesn't show up as a fetch()-level rejection at all.
      var errorMatch = rawText.match(/\n\n\[Error: ([^\]]*)\]$/);
      if (!errorMatch) return;
      if (typing) typing = false;
      var withoutError = rawText.slice(0, errorMatch.index);
      assistantBubble.innerHTML = (withoutError.trim() ? renderMarkdown(withoutError) : '') + '<p>' + escapeHtml(errorMatch[1]) + '</p>';
      assistantBubble.wrap.className = 'ai-chat-widget-message ai-chat-widget-message-error';
      assistantBubble.meta.appendChild(makeRetryButton(text));
    }).catch(function (err) {
      if (typing) { typing = false; assistantBubble.textContent = ''; }
      assistantBubble.textContent += '\n[Error: ' + err.message + ']';
      assistantBubble.wrap.className = 'ai-chat-widget-message ai-chat-widget-message-error';
      assistantBubble.meta.appendChild(makeRetryButton(text));
    }).then(function () {
      assistantBubble.time.textContent = formatTime();
      // Only worth flagging as unread if nobody could actually see it land — the panel closed, or
      // open on a different conversation than the one this reply belongs to.
      if (panel.hidden || currentConversationId !== sentForConversationId) markUnread(sentForConversationId);
      textarea.disabled = false;
      sendBtn.disabled = false;
      textarea.focus();
    });
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentConversationId) return;
    var textarea = composer.querySelector('textarea');
    var text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    sendMessage(text);
  });

  // Enter sends, Shift+Enter inserts a newline — same convention as every other single-line-by-
  // default composer in this app would use if one already existed; this is the first.
  composer.querySelector('textarea').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  // Drag-to-resize, top-left corner — same handle-and-CSS-variable mechanic as the Help drawer's
  // own .help-drawer-resize-handle (see foot.ejs), just both width AND height at once instead of
  // one edge. The panel's bottom-right corner is pinned to the launcher it opens from, so dragging
  // left/up (decreasing clientX/clientY) is what GROWS it, not shrinks it.
  (function () {
    var handle = document.getElementById('ai-chat-panel-resize-handle');
    if (!handle) return;
    var WIDTH_KEY = 'aiChatPanelWidth';
    var HEIGHT_KEY = 'aiChatPanelHeight';
    var MIN_WIDTH = 320;
    var MIN_HEIGHT = 360;

    function maxWidth() { return window.innerWidth * 0.92; }
    function maxHeight() { return window.innerHeight * 0.85; }

    var savedWidth = localStorage.getItem(WIDTH_KEY);
    var savedHeight = localStorage.getItem(HEIGHT_KEY);
    if (savedWidth) document.documentElement.style.setProperty('--ai-chat-panel-width', Math.min(Number(savedWidth), maxWidth()) + 'px');
    if (savedHeight) document.documentElement.style.setProperty('--ai-chat-panel-height', Math.min(Number(savedHeight), maxHeight()) + 'px');

    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startX = e.clientX;
      var startY = e.clientY;
      var rect = panel.getBoundingClientRect();
      var startWidth = rect.width;
      var startHeight = rect.height;
      handle.classList.add('dragging');
      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        var width = Math.max(MIN_WIDTH, Math.min(maxWidth(), startWidth + (startX - e.clientX)));
        var height = Math.max(MIN_HEIGHT, Math.min(maxHeight(), startHeight + (startY - e.clientY)));
        document.documentElement.style.setProperty('--ai-chat-panel-width', width + 'px');
        document.documentElement.style.setProperty('--ai-chat-panel-height', height + 'px');
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(WIDTH_KEY, getComputedStyle(document.documentElement).getPropertyValue('--ai-chat-panel-width').trim().replace('px', ''));
        localStorage.setItem(HEIGHT_KEY, getComputedStyle(document.documentElement).getPropertyValue('--ai-chat-panel-height').trim().replace('px', ''));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // Restore where this was left on whichever page the visitor navigated away from — open/closed;
  // openPanel() itself takes care of jumping back into whichever conversation's thread was open.
  if (localStorage.getItem(OPEN_KEY) === '1') openPanel();
})();
