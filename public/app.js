(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var me = null, maxMb = 20, current = null, lastId = 0, pollTimer = null, convTimer = null, mode = 'login', pendingFile = null, sending = false;

  function api(method, url, body) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && url !== '/api/login') { showAuth(); }
        if (!r.ok) throw new Error(d.error || ('Ошибка ' + r.status));
        return d;
      });
    });
  }
  function toast(t) { var el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.add('hidden'); }, 3000); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function color(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return 'hsl(' + h + ',55%,52%)'; }
  function avatar(name, self) { return '<div class="avatar" style="background:' + (self ? '#f5a524' : color(name)) + '">' + (self ? '⭐' : esc(name[0].toUpperCase())) + '</div>'; }
  function fmtSize(b) { if (b < 1024) return b + ' Б'; if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ'; return (b / 1048576).toFixed(1) + ' МБ'; }
  function fmtTime(t) { var d = new Date(t); return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(t) { var d = new Date(t), n = new Date(); if (d.toDateString() === n.toDateString()) return 'Сегодня'; var y = new Date(n - 864e5); if (d.toDateString() === y.toDateString()) return 'Вчера'; return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' }); }
  function shortTime(t) { var d = new Date(t); return d.toDateString() === new Date().toDateString() ? fmtTime(t) : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
  function fileIcon(mime, name) {
    if (/^image\//.test(mime)) return '🖼️'; if (/^video\//.test(mime)) return '🎬'; if (/^audio\//.test(mime)) return '🎵';
    if (/pdf/.test(mime)) return '📕'; if (/zip|rar|7z|tar|gzip/.test(mime + name)) return '🗜️'; return '📄';
  }

  // ---------- авторизация ----------
  function showAuth() { stopPolling(); me = null; $('app').classList.add('hidden'); $('auth').classList.remove('hidden'); }
  document.querySelectorAll('.tab').forEach(function (b) {
    b.onclick = function () {
      mode = b.dataset.mode;
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === b); });
      $('authBtn').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
      $('authForm').password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('authErr').textContent = '';
    };
  });
  $('authForm').onsubmit = function (e) {
    e.preventDefault();
    var f = e.target; $('authErr').textContent = ''; $('authBtn').disabled = true;
    api('POST', '/api/' + mode, { username: f.username.value, password: f.password.value })
      .then(function (d) { f.password.value = ''; start(d.user); })
      .catch(function (err) { $('authErr').textContent = err.message; })
      .then(function () { $('authBtn').disabled = false; });
  };
  $('logoutBtn').onclick = function () { api('POST', '/api/logout').then(showAuth); };

  function start(user) {
    me = user; $('meName').textContent = me.username;
    $('auth').classList.add('hidden'); $('app').classList.remove('hidden');
    loadConvs(); clearInterval(convTimer); convTimer = setInterval(loadConvs, 8000);
    var h = decodeURIComponent(location.hash.slice(1)); if (h) openChat(h);
  }
  function stopPolling() { clearInterval(pollTimer); clearInterval(convTimer); }

  // ---------- список ----------
  function convItem(u, last, unread) {
    var self = u.username === me.username;
    return '<div class="item' + (current && current.toLowerCase() === u.username.toLowerCase() ? ' active' : '') + '" data-user="' + esc(u.username) + '">' + avatar(u.username, self) +
      '<div class="meta"><div class="name"><span>' + (self ? 'Избранное' : esc(u.username)) + '</span>' + (last && last.created_at ? '<small>' + shortTime(last.created_at) + '</small>' : '') + '</div>' +
      '<div class="last">' + (last ? esc(last.text) : (self ? 'Перекинуть файлы себе' : 'Начать переписку')) + '</div></div>' + (unread ? '<span class="badge">' + unread + '</span>' : '') + '</div>';
  }
  function bindItems(el) { el.querySelectorAll('.item').forEach(function (i) { i.onclick = function () { $('search').value = ''; $('searchResults').innerHTML = ''; openChat(i.dataset.user); }; }); }
  function loadConvs() {
    if (!me) return;
    api('GET', '/api/conversations').then(function (d) {
      var hasSelf = d.conversations.some(function (c) { return c.id === me.id; });
      var html = d.conversations.map(function (c) {
        var txt = c.file_name ? ((/^image\//.test(c.file_mime) ? '📷 ' : '📎 ') + c.file_name) : (c.body || '');
        if (c.sender_id === me.id && c.id !== me.id) txt = 'Вы: ' + txt;
        return convItem(c, { text: txt, created_at: c.created_at }, c.unread);
      }).join('');
      if (!hasSelf) html += convItem(me, null, 0);
      $('convs').innerHTML = html; bindItems($('convs'));
    }).catch(function () {});
  }
  var searchT;
  $('search').oninput = function () {
    clearTimeout(searchT);
    var q = this.value.trim();
    if (!q) { $('searchResults').innerHTML = ''; return; }
    searchT = setTimeout(function () {
      api('GET', '/api/users?q=' + encodeURIComponent(q)).then(function (d) {
        $('searchResults').innerHTML = d.users.length ? d.users.map(function (u) { return convItem(u, null, 0); }).join('') : '<div class="muted" style="padding:10px 16px">Никого не нашли</div>';
        bindItems($('searchResults'));
      });
    }, 250);
  };
  $('selfBtn').onclick = function () { openChat(me.username); };
  $('backBtn').onclick = function () { current = null; location.hash = ''; $('app').classList.remove('in-chat'); clearInterval(pollTimer); $('chatView').classList.add('hidden'); $('empty').classList.remove('hidden'); loadConvs(); };

  // ---------- чат ----------
  function openChat(username) {
    current = username; lastId = 0; lastDay = '';
    location.hash = encodeURIComponent(username);
    $('messages').innerHTML = '';
    $('empty').classList.add('hidden'); $('chatView').classList.remove('hidden'); $('app').classList.add('in-chat');
    var self = username.toLowerCase() === me.username.toLowerCase();
    $('chatName').textContent = self ? 'Избранное' : username;
    $('chatAvatar').outerHTML = avatar(username, self).replace('class="avatar"', 'class="avatar" id="chatAvatar"');
    fetchMessages(true);
    clearInterval(pollTimer); pollTimer = setInterval(function () { fetchMessages(false); }, 3000);
    document.querySelectorAll('#convs .item').forEach(function (i) { i.classList.toggle('active', i.dataset.user.toLowerCase() === username.toLowerCase()); });
    if (window.innerWidth > 760) $('text').focus();
  }
  var lastDay = '';
  function fetchMessages(first) {
    var who = current;
    api('GET', '/api/messages/' + encodeURIComponent(who) + '?after=' + lastId).then(function (d) {
      if (who !== current) return;
      if (first) { current = d.user.username; }
      if (d.messages.length) { appendMessages(d.messages); if (!first) loadConvs(); }
      else if (first) { $('messages').innerHTML = '<div class="day" id="noMsgs">Сообщений пока нет — отправьте первое!</div>'; }
    }).catch(function (e) { if (first) { toast(e.message); $('backBtn').onclick(); } });
  }
  function renderMsg(m) {
    var mine = m.sender_id === me.id, html = '';
    if (m.file) {
      var url = '/api/files/' + m.file.id;
      var isImg = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(m.file.mime);
      if (isImg) html += '<img class="photo" loading="lazy" src="' + url + '" alt="' + esc(m.file.name) + '" data-full="' + url + '">';
      else if (/^video\/(mp4|webm)$/.test(m.file.mime)) html += '<video controls preload="metadata" src="' + url + '"></video>';
      if (!isImg) html += '<a class="file" href="' + url + '?download=1" download="' + esc(m.file.name) + '"><div class="ficon">' + fileIcon(m.file.mime, m.file.name) + '</div><div><div class="fname">' + esc(m.file.name) + '</div><div class="fsize">' + fmtSize(m.file.size) + ' · скачать</div></div></a>';
    }
    if (m.body) html += '<div class="text">' + linkify(esc(m.body)) + '</div>';
    var actions = '';
    if (m.file && /^image\//.test(m.file.mime)) actions += '<a href="/api/files/' + m.file.id + '?download=1" download="' + esc(m.file.name) + '">скачать</a>';
    if (m.file) actions += '<button data-share="' + m.file.id + '">ссылка</button>';
    if (mine) actions += '<button data-del="' + m.id + '">удалить</button>';
    html += '<div class="time">' + actions + '<span>' + fmtTime(m.created_at) + '</span></div>';
    return '<div class="msg' + (mine ? ' mine' : '') + '" data-id="' + m.id + '">' + html + '</div>';
  }
  function linkify(s) { return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit">$1</a>'); }
  function appendMessages(list) {
    var box = $('messages'), nm = $('noMsgs'); if (nm) nm.remove();
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || lastId === 0;
    var html = '';
    list.forEach(function (m) {
      if (m.id <= lastId || box.querySelector('[data-id="' + m.id + '"]')) return;
      var day = fmtDay(m.created_at); if (day !== lastDay) { html += '<div class="day">' + day + '</div>'; lastDay = day; }
      html += renderMsg(m); lastId = Math.max(lastId, m.id);
    });
    box.insertAdjacentHTML('beforeend', html);
    if (atBottom) { box.scrollTop = box.scrollHeight; box.querySelectorAll('img.photo').forEach(function (img) { if (!img.complete) img.onload = function () { box.scrollTop = box.scrollHeight; }; }); }
  }
  $('messages').onclick = function (e) {
    var t = e.target;
    if (t.matches('img.photo')) { $('viewerImg').src = t.dataset.full; $('viewer').classList.remove('hidden'); }
    else if (t.dataset.del) {
      if (!confirm('Удалить сообщение?')) return;
      api('DELETE', '/api/messages/' + t.dataset.del).then(function () { var el = t.closest('.msg'); el.remove(); loadConvs(); }).catch(function (e) { toast(e.message); });
    } else if (t.dataset.share) {
      api('POST', '/api/files/' + t.dataset.share + '/share').then(function (d) {
        var done = function () { toast('Публичная ссылка скопирована: ' + d.url); };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(d.url).then(done, function () { prompt('Ссылка на файл:', d.url); });
        else prompt('Ссылка на файл (её можно открыть без входа):', d.url);
      }).catch(function (e) { toast(e.message); });
    }
  };
  $('viewer').onclick = function () { $('viewer').classList.add('hidden'); $('viewerImg').src = ''; };

  // ---------- отправка ----------
  function setFile(f) {
    if (!f) { pendingFile = null; $('attach').classList.add('hidden'); $('fileInput').value = ''; $('photoInput').value = ''; return; }
    if (f.size > maxMb * 1048576) { toast('Файл больше ' + maxMb + ' МБ — так нельзя 😕'); return; }
    pendingFile = f; $('attachName').textContent = '📎 ' + f.name + ' (' + fmtSize(f.size) + ')'; $('attach').classList.remove('hidden');
  }
  $('fileInput').onchange = function () { setFile(this.files[0]); };
  $('photoInput').onchange = function () { setFile(this.files[0]); };
  $('attachClear').onclick = function () { setFile(null); };
  var ta = $('text');
  ta.oninput = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
  ta.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 760) { e.preventDefault(); $('sendForm').requestSubmit ? $('sendForm').requestSubmit() : $('sendBtn').click(); } };
  ta.onpaste = function (e) {
    var items = (e.clipboardData || {}).files; if (items && items.length) { e.preventDefault(); var f = items[0]; if (!f.name || f.name === 'image.png') f = new File([f], 'фото-' + Date.now() + '.png', { type: f.type }); setFile(f); }
  };
  var cv = $('chatView'), dragN = 0;
  cv.addEventListener('dragenter', function (e) { e.preventDefault(); dragN++; $('dropHint').classList.remove('hidden'); });
  cv.addEventListener('dragleave', function () { if (--dragN <= 0) { dragN = 0; $('dropHint').classList.add('hidden'); } });
  cv.addEventListener('dragover', function (e) { e.preventDefault(); });
  cv.addEventListener('drop', function (e) { e.preventDefault(); dragN = 0; $('dropHint').classList.add('hidden'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

  $('sendForm').onsubmit = function (e) {
    e.preventDefault();
    if (sending || !current) return;
    var text = ta.value.trim();
    if (!text && !pendingFile) return;
    var fd = new FormData(); fd.append('text', text); if (pendingFile) fd.append('file', pendingFile, pendingFile.name);
    sending = true; $('sendBtn').disabled = true;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/messages/' + encodeURIComponent(current));
    if (pendingFile) { $('progress').classList.remove('hidden'); $('bar').style.width = '0'; }
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) $('bar').style.width = (ev.loaded / ev.total * 100) + '%'; };
    xhr.onload = function () {
      var d = {}; try { d = JSON.parse(xhr.responseText); } catch (er) {}
      if (xhr.status === 200) { ta.value = ''; ta.oninput(); setFile(null); appendMessages([d.message]); $('messages').scrollTop = 1e9; loadConvs(); }
      else if (xhr.status === 401) showAuth();
      else toast(d.error || 'Не удалось отправить (' + xhr.status + ')');
      done();
    };
    xhr.onerror = function () { toast('Нет связи с сервером'); done(); };
    function done() { sending = false; $('sendBtn').disabled = false; $('progress').classList.add('hidden'); }
    xhr.send(fd);
  };

  window.addEventListener('hashchange', function () { var h = decodeURIComponent(location.hash.slice(1)); if (me && h && (!current || h.toLowerCase() !== current.toLowerCase())) openChat(h); });

  api('GET', '/api/me').then(function (d) {
    maxMb = d.maxFileMb || 20; document.querySelectorAll('.maxmb').forEach(function (e) { e.textContent = maxMb; });
    if (d.user) start(d.user); else showAuth();
  }).catch(function () { showAuth(); });
})();
