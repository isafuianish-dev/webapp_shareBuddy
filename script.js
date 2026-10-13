(function () {
  'use strict';

  var APP_KEY = 'webapp_shareBuddy';
  var APP_VERSION = '001.001';

  // The public PeerJS broker only introduces the two devices (it maps the 6-digit code to a peer);
  // files never pass through it. STUN only, no TURN relay, so file data is never routed via a third party.
  var PEER_ID_PREFIX = 'sharebuddy-';
  var PEER_OPTIONS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } };

  var CHUNK_SIZE = 16 * 1024; // the largest size that is safe between all browsers
  var BUFFER_HIGH = 1024 * 1024;
  var BUFFER_LOW = 256 * 1024;
  var CONNECT_TIMEOUT_MS = 20000;
  var CODE_ATTEMPTS = 6;

  var ICONS = Buddy.ICONS;
  var escapeHtml = Buddy.escapeHtml;

  var dom = {};
  var state = {
    role: null, // 'send' | 'receive' once a pairing starts
    peer: null,
    conn: null, // the approved connection
    pending: null, // a connection waiting for the sender to allow it
    connected: false,
    queue: [],
    sending: false,
    incoming: null,
    received: [],
    nextId: 1,
    timer: null
  };

  var modalApi = Buddy.modal.init();

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    var ids = ['layout', 'connBadge', 'btnReset', 'btnSettings', 'paneSend', 'paneReceive', 'dropzone', 'dropzoneIcon', 'fileInput',
      'sendList', 'btnGetCode', 'codeBox', 'codeDisplay', 'btnCopyCode', 'allowBox', 'btnAllow', 'btnDeny', 'sendError',
      'joinForm', 'codeInput', 'btnJoin', 'receiveStatus', 'receiveError', 'receiveHead', 'btnSaveAll', 'receiveList'];
    ids.forEach(function (id) { dom[id] = document.getElementById(id); });

    dom.btnSettings.innerHTML = ICONS.settings;
    dom.dropzoneIcon.innerHTML = ICONS.upload;

    dom.btnSettings.addEventListener('click', function () {
      Buddy.settings.open(APP_KEY, modalApi.open, modalApi.close, { appVersion: APP_VERSION });
    });
    dom.btnReset.addEventListener('click', resetAll);

    // Using a pane picks it: the other one is hidden until "Start over". (Not on mousedown/focus:
    // the layout shift would move the button out from under the pointer and swallow the click.)
    [['send', dom.paneSend], ['receive', dom.paneReceive]].forEach(function (entry) {
      ['click', 'input', 'drop'].forEach(function (type) {
        entry[1].addEventListener(type, function () { selectRole(entry[0]); });
      });
    });

    dom.fileInput.addEventListener('change', function () {
      addFiles(dom.fileInput.files);
      dom.fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      dom.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        dom.dropzone.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      dom.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        dom.dropzone.classList.remove('is-over');
      });
    });
    dom.dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    dom.btnGetCode.addEventListener('click', startSending);
    dom.btnCopyCode.addEventListener('click', copyCode);
    dom.btnAllow.addEventListener('click', allowPending);
    dom.btnDeny.addEventListener('click', denyPending);
    dom.joinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      joinWithCode(dom.codeInput.value);
    });
    dom.codeInput.addEventListener('input', function () {
      var digits = dom.codeInput.value.replace(/\D/g, '').slice(0, 6);
      dom.codeInput.value = digits.length > 3 ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits;
    });
    dom.btnSaveAll.addEventListener('click', saveAll);

    window.addEventListener('beforeunload', function (e) {
      if (state.sending || state.incoming) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    renderSendList();
    renderReceiveList();
  }

  // ---------------------------------------------------------------- pairing

  function randomCode() {
    var n = new Uint32Array(1);
    do { crypto.getRandomValues(n); } while (n[0] >= 4294000000); // avoid modulo bias
    return String(n[0] % 1000000).padStart(6, '0');
  }

  function showCode(code) {
    dom.codeDisplay.textContent = code.slice(0, 3) + ' ' + code.slice(3);
    dom.codeBox.hidden = false;
  }

  function startSending(attempt) {
    if (state.role === 'send' && state.peer) return;
    attempt = typeof attempt === 'number' ? attempt : 1;
    clearError('sendError');
    state.role = 'send';
    applyRoleLayout();
    dom.btnGetCode.disabled = true;
    setBadge('waiting', 'Getting code…');

    var code = randomCode();
    var peer = new Peer(PEER_ID_PREFIX + code, PEER_OPTIONS);
    closePeer();
    state.peer = peer;

    peer.on('open', function () {
      if (state.peer !== peer) return;
      dom.btnGetCode.hidden = true;
      showCode(code);
      setBadge('waiting', 'Waiting for the other device');
    });
    peer.on('connection', function (conn) { onIncomingConnection(peer, conn); });
    peer.on('disconnected', function () {
      if (state.peer === peer && !peer.destroyed && !state.connected) peer.reconnect();
    });
    peer.on('error', function (err) {
      if (state.peer !== peer || state.connected) return;
      if (err.type === 'unavailable-id' && attempt < CODE_ATTEMPTS) {
        peer.destroy();
        state.peer = null;
        return startSending(attempt + 1);
      }
      dom.btnGetCode.disabled = false;
      dom.btnGetCode.hidden = false;
      dom.codeBox.hidden = true;
      failWith('sendError', describePeerError(err));
    });
  }

  function onIncomingConnection(peer, conn) {
    if (state.peer !== peer || state.pending || state.connected) {
      conn.on('open', function () { conn.close(); });
      return;
    }
    state.pending = conn;
    conn.on('open', function () {
      if (state.pending !== conn) return;
      dom.allowBox.hidden = false;
    });
    conn.on('close', function () {
      if (state.pending === conn) {
        state.pending = null;
        dom.allowBox.hidden = true;
      }
    });
  }

  function allowPending() {
    var conn = state.pending;
    if (!conn) return;
    state.pending = null;
    dom.allowBox.hidden = true;
    state.conn = conn;
    bindConnection(conn);
    conn.send(JSON.stringify({ t: 'hello' }));
    onConnected();
    pump();
  }

  function denyPending() {
    var conn = state.pending;
    state.pending = null;
    dom.allowBox.hidden = true;
    if (conn) conn.close();
  }

  function joinWithCode(input) {
    clearError('receiveError');
    var digits = String(input || '').replace(/\D/g, '');
    if (digits.length !== 6) return failWith('receiveError', 'Enter the 6-digit code from the sending device.');

    state.role = 'receive';
    applyRoleLayout();
    dom.btnJoin.disabled = true;
    dom.codeInput.disabled = true;
    setStatus('Connecting…');
    setBadge('waiting', 'Connecting…');

    closePeer();
    var peer = new Peer(undefined, PEER_OPTIONS);
    state.peer = peer;

    var giveUp = function (message) {
      if (state.peer !== peer || state.connected) return;
      failWith('receiveError', message);
      dom.btnJoin.disabled = false;
      dom.codeInput.disabled = false;
      setStatus('');
      closePeer();
    };

    peer.on('open', function () {
      if (state.peer !== peer) return;
      var conn = peer.connect(PEER_ID_PREFIX + digits, { serialization: 'raw', reliable: true });
      state.conn = conn;
      bindConnection(conn);
      conn.on('open', function () { setStatus('Waiting for the sender to allow this device…'); });
      conn.on('close', function () { giveUp('The sender did not allow the connection.'); });
      clearTimeout(state.timer);
      state.timer = setTimeout(function () {
        giveUp(conn.open
          ? 'The sender has not allowed the connection yet. Ask them to click Allow, then try again.'
          : 'Could not connect. Both devices need to be on the same network, and it must allow devices to reach each other (guest Wi-Fi often does not).');
      }, CONNECT_TIMEOUT_MS);
    });
    peer.on('error', function (err) { giveUp(describePeerError(err)); });
  }

  function describePeerError(err) {
    switch (err.type) {
      case 'peer-unavailable': return 'No device is waiting with that code. Check it and try again.';
      case 'unavailable-id': return 'Could not get a free code. Try again.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return 'Could not reach the pairing service. Check your internet connection and try again.';
      case 'webrtc': return 'The devices could not connect to each other. Are they on the same network?';
      default: return err.message || String(err);
    }
  }

  function closePeer() {
    clearTimeout(state.timer);
    var peer = state.peer;
    state.peer = null;
    state.conn = null;
    if (peer && !peer.destroyed) peer.destroy();
  }

  function onConnected() {
    clearTimeout(state.timer);
    state.connected = true;
    setBadge('connected', 'Connected');
    clearError('sendError');
    clearError('receiveError');
    if (state.role === 'send') {
      dom.codeBox.hidden = true;
    } else {
      dom.joinForm.hidden = true;
      setStatus('Connected. Waiting for files…');
    }
    // Once the pairing is done the code is no longer needed, so free it up.
    if (state.peer && !state.peer.disconnected) state.peer.disconnect();
  }

  function resetAll() {
    denyPending();
    closePeer();
    state.role = null;
    state.connected = false;
    state.queue = [];
    state.sending = false;
    state.incoming = null;
    state.received.forEach(function (r) { if (r.url) URL.revokeObjectURL(r.url); });
    state.received = [];
    dom.btnGetCode.hidden = false;
    dom.btnGetCode.disabled = false;
    dom.codeBox.hidden = true;
    dom.joinForm.hidden = false;
    dom.btnJoin.disabled = false;
    dom.codeInput.disabled = false;
    dom.codeInput.value = '';
    setStatus('');
    clearError('sendError');
    clearError('receiveError');
    setBadge('idle', 'Not connected');
    applyRoleLayout();
    renderSendList();
    renderReceiveList();
  }

  function selectRole(role) {
    if (state.role) return;
    state.role = role;
    applyRoleLayout();
  }

  function applyRoleLayout() {
    dom.paneSend.hidden = state.role === 'receive';
    dom.paneReceive.hidden = state.role === 'send';
    if (state.role) dom.layout.dataset.role = state.role;
    else delete dom.layout.dataset.role;
    dom.btnReset.hidden = !state.role;
  }

  // ---------------------------------------------------------------- data connection + transfer

  function bindConnection(conn) {
    var tune = function () {
      if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW;
    };
    tune();
    conn.on('open', tune);
    conn.on('data', onData);
    conn.on('close', function () {
      if (state.conn !== conn) return;
      state.connected = false;
      if (state.incoming) failIncoming('Connection closed before the file finished.');
      state.queue.forEach(function (item) {
        if (item.status === 'sending') markItem(item, 'error', 'Connection lost');
      });
      setBadge('idle', 'Disconnected');
      renderReceiveList();
    });
    conn.on('error', function (err) {
      failWith(state.role === 'send' ? 'sendError' : 'receiveError', describePeerError(err));
    });
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList, function (file) {
      state.queue.push({ id: state.nextId++, file: file, status: 'queued', sent: 0, message: 'Queued' });
    });
    renderSendList();
    pump();
  }

  function isOpen() {
    var dc = state.conn && state.conn.dataChannel;
    return !!dc && dc.readyState === 'open';
  }

  async function pump() {
    if (state.sending || state.role !== 'send' || !state.connected || !isOpen()) return;
    state.sending = true;
    try {
      var item;
      while ((item = state.queue.find(function (q) { return q.status === 'queued'; }))) {
        item.status = 'sending';
        try {
          await sendFile(item);
          markItem(item, 'done', 'Delivered');
        } catch (err) {
          markItem(item, 'error', err.message || 'Failed');
          if (!isOpen()) break;
        }
      }
    } finally {
      state.sending = false;
    }
  }

  function waitForDrain(dc) {
    return new Promise(function (resolve, reject) {
      var timer = setInterval(check, 250);
      dc.addEventListener('bufferedamountlow', check);
      function check() {
        if (dc.readyState !== 'open') return finish(reject, new Error('Connection lost'));
        if (dc.bufferedAmount <= BUFFER_LOW) finish(resolve);
      }
      function finish(fn, arg) {
        clearInterval(timer);
        dc.removeEventListener('bufferedamountlow', check);
        fn(arg);
      }
    });
  }

  async function sendFile(item) {
    var conn = state.conn;
    var dc = conn.dataChannel;
    var file = item.file;
    conn.send(JSON.stringify({ t: 'file', id: item.id, name: file.name, size: file.size, type: file.type }));
    var offset = 0;
    var lastPaint = 0;
    while (offset < file.size) {
      if (!isOpen()) throw new Error('Connection lost');
      if (dc.bufferedAmount > BUFFER_HIGH) await waitForDrain(dc);
      var buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      conn.send(buf);
      offset += buf.byteLength;
      item.sent = offset;
      var now = Date.now();
      if (now - lastPaint > 100) {
        lastPaint = now;
        markItem(item, 'sending', Math.floor((offset / file.size) * 100) + '%');
      }
    }
    markItem(item, 'sending', 'Finishing…');
    await new Promise(function (resolve, reject) {
      item.ack = { resolve: resolve, reject: reject };
      conn.send(JSON.stringify({ t: 'done', id: item.id }));
      var poll = setInterval(function () {
        if (!isOpen()) { clearInterval(poll); reject(new Error('Connection lost')); }
        else if (item.status !== 'sending') clearInterval(poll);
      }, 500);
    });
  }

  function onData(data) {
    if (typeof data === 'string') {
      var msg;
      try { msg = JSON.parse(data); } catch (err) { return; }
      if (state.role === 'receive') {
        if (msg.t === 'hello' && !state.connected) onConnected();
        else if (!state.connected) return;
        else if (msg.t === 'file') startIncoming(msg);
        else if (msg.t === 'done') finishIncoming(msg);
      } else if (msg.t === 'ack') {
        handleAck(msg);
      }
      return;
    }
    if (state.incoming && data && data.byteLength != null) {
      state.incoming.parts.push(data);
      state.incoming.received += data.byteLength;
      paintIncoming(state.incoming);
    }
  }

  function handleAck(msg) {
    var item = state.queue.find(function (q) { return q.id === msg.id; });
    if (!item || !item.ack) return;
    if (msg.ok) item.ack.resolve();
    else item.ack.reject(new Error('The other device reported a size mismatch.'));
    item.ack = null;
  }

  function startIncoming(meta) {
    var rec = {
      id: meta.id,
      name: safeName(meta.name),
      size: Number(meta.size) || 0,
      type: meta.type || 'application/octet-stream',
      parts: [],
      received: 0,
      url: null,
      status: 'receiving'
    };
    state.incoming = rec;
    state.received.push(rec);
    renderReceiveList();
  }

  function finishIncoming(msg) {
    var rec = state.incoming;
    if (!rec || rec.id !== msg.id) return;
    state.incoming = null;
    var ok = rec.received === rec.size;
    if (ok) {
      rec.url = URL.createObjectURL(new Blob(rec.parts, { type: rec.type }));
      rec.status = 'done';
    } else {
      rec.status = 'error';
      rec.message = 'Incomplete (' + formatBytes(rec.received) + ' of ' + formatBytes(rec.size) + ')';
    }
    rec.parts = [];
    if (state.conn) state.conn.send(JSON.stringify({ t: 'ack', id: rec.id, ok: ok }));
    renderReceiveList();
  }

  function failIncoming(message) {
    var rec = state.incoming;
    state.incoming = null;
    rec.status = 'error';
    rec.message = message;
    rec.parts = [];
    renderReceiveList();
  }

  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file';
  }

  function saveAll() {
    state.received.filter(function (r) { return r.url; }).forEach(function (r, i) {
      setTimeout(function () { triggerDownload(r); }, i * 300);
    });
  }

  function triggerDownload(rec) {
    var a = document.createElement('a');
    a.href = rec.url;
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------------------------------------------------------------- rendering

  function markItem(item, status, message) {
    item.status = status;
    item.message = message;
    var li = document.getElementById('send-' + item.id);
    if (!li) return renderSendList();
    var meta = li.querySelector('.file-meta');
    meta.textContent = formatBytes(item.file.size) + ' · ' + message;
    meta.dataset.state = status === 'sending' || status === 'queued' ? '' : status;
    li.querySelector('.file-bar > span').style.width = (status === 'done' ? 100 : (item.file.size ? (item.sent / item.file.size) * 100 : 0)) + '%';
    var remove = li.querySelector('[data-remove]');
    if (remove) remove.hidden = status !== 'queued';
  }

  function renderSendList() {
    dom.sendList.innerHTML = state.queue.map(function (item) {
      var pct = item.status === 'done' ? 100 : (item.file.size ? (item.sent / item.file.size) * 100 : 0);
      return '<li class="file-item" id="send-' + item.id + '">' +
        '<span class="file-name" title="' + escapeHtml(item.file.name) + '">' + escapeHtml(item.file.name) + '</span>' +
        '<span class="file-action"><button type="button" class="btn btn-ghost btn-icon" data-remove="' + item.id + '" aria-label="Remove ' + escapeHtml(item.file.name) + '"' + (item.status === 'queued' ? '' : ' hidden') + '>' + ICONS.x + '</button></span>' +
        '<span class="file-meta" data-state="' + (item.status === 'done' || item.status === 'error' ? item.status : '') + '">' +
        escapeHtml(formatBytes(item.file.size)) + ' · ' + escapeHtml(item.message) + '</span>' +
        '<span class="file-bar"><span style="width:' + pct + '%"></span></span></li>';
    }).join('');
    dom.sendList.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-remove'));
        state.queue = state.queue.filter(function (q) { return !(q.id === id && q.status === 'queued'); });
        renderSendList();
      });
    });
  }

  function paintIncoming(rec) {
    var li = document.getElementById('recv-' + rec.id);
    if (!li) return;
    var pct = rec.size ? Math.min(100, (rec.received / rec.size) * 100) : 0;
    li.querySelector('.file-bar > span').style.width = pct + '%';
    li.querySelector('.file-meta').textContent = formatBytes(rec.received) + ' of ' + formatBytes(rec.size);
  }

  function renderReceiveList() {
    dom.receiveHead.hidden = !state.received.some(function (r) { return r.url; });
    dom.receiveList.innerHTML = state.received.map(function (rec) {
      var meta;
      if (rec.status === 'done') meta = formatBytes(rec.size) + ' · Received';
      else if (rec.status === 'error') meta = rec.message || 'Failed';
      else meta = formatBytes(rec.received) + ' of ' + formatBytes(rec.size);
      var pct = rec.status === 'done' ? 100 : (rec.size ? (rec.received / rec.size) * 100 : 0);
      return '<li class="file-item" id="recv-' + rec.id + '">' +
        '<span class="file-name" title="' + escapeHtml(rec.name) + '">' + escapeHtml(rec.name) + '</span>' +
        '<span class="file-action">' + (rec.url ? '<button type="button" class="btn btn-primary" data-save="' + rec.id + '">Save</button>' : '') + '</span>' +
        '<span class="file-meta" data-state="' + (rec.status === 'receiving' ? '' : rec.status) + '">' + escapeHtml(meta) + '</span>' +
        '<span class="file-bar"><span style="width:' + pct + '%"></span></span></li>';
    }).join('');
    dom.receiveList.querySelectorAll('[data-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rec = state.received.find(function (r) { return r.id === Number(btn.getAttribute('data-save')); });
        if (rec && rec.url) triggerDownload(rec);
      });
    });
  }

  function setBadge(stateName, text) {
    dom.connBadge.dataset.state = stateName;
    dom.connBadge.textContent = text;
  }

  function setStatus(text) {
    dom.receiveStatus.textContent = text;
    dom.receiveStatus.hidden = !text;
  }

  function failWith(errorId, message) {
    var el = dom[errorId];
    el.textContent = message;
    el.hidden = false;
    setBadge('error', 'Error');
  }

  function clearError(errorId) {
    dom[errorId].hidden = true;
    dom[errorId].textContent = '';
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i];
  }

  function copyCode() {
    var text = dom.codeDisplay.textContent.replace(/\s/g, '');
    var done = function () {
      var old = dom.btnCopyCode.textContent;
      dom.btnCopyCode.textContent = 'Copied';
      setTimeout(function () { dom.btnCopyCode.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else done();
  }
})();
