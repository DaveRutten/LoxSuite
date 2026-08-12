// Streams the assistant's reply straight out of the fetch() response body via a plain
// ReadableStream reader — the browser's own streaming-fetch engine — rather than polling a
// separate endpoint or opening this app's first EventSource/WebSocket-to-browser connection. The
// POST response body IS the stream (see routes/aiChat.js's own res.write() per token).
(function () {
  var messagesEl = document.getElementById('ai-chat-messages');
  var composer = document.getElementById('ai-chat-composer');
  if (!messagesEl || !composer) return;
  var conversationId = messagesEl.dataset.conversationId;

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'ai-chat-message ai-chat-message-' + role;
    var content = document.createElement('div');
    content.className = 'ai-chat-message-content';
    content.textContent = text;
    wrap.appendChild(content);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return content;
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var textarea = composer.querySelector('textarea[name="content"]');
    var text = textarea.value.trim();
    if (!text) return;

    var sendBtn = composer.querySelector('button[type="submit"]');
    textarea.value = '';
    textarea.disabled = true;
    sendBtn.disabled = true;

    addMessage('user', text);
    var assistantContent = addMessage('assistant', '');

    fetch('/ai-chat/' + conversationId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
      .then(function (resp) {
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
            assistantContent.textContent += decoder.decode(result.value, { stream: true });
            scrollToBottom();
            return read();
          });
        }
        return read();
      })
      .catch(function (err) {
        assistantContent.textContent += '\n[Error: ' + err.message + ']';
      })
      .then(function () {
        textarea.disabled = false;
        sendBtn.disabled = false;
        textarea.focus();
      });
  });
})();
