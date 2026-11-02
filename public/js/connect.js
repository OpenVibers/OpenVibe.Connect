/* OpenVibe Connect: a share's page notices when its computer connects (or drops), so someone running the command for
   the first time sees "Connected" without reloading. It asks /api/v1/shares/:id every 4 seconds while the page is
   visible, for at most ten minutes, and changes only the state line. Without this script the page is complete. */
(function () {
    'use strict';
    var head = document.querySelector('[data-cn-share]');
    if (!head || !window.fetch) return;
    var id = head.getAttribute('data-cn-share');
    var state = head.querySelector('.cn-state');
    var line = head.querySelector('[data-cn-line]');
    if (!state || !line || state.classList.contains('is-closed')) return;
    var started = Date.now();
    var last = state.classList.contains('is-on');
    function show(on) {
        if (on === last) return;
        last = on;
        state.classList.toggle('is-on', on);
        state.classList.toggle('is-off', !on);
        state.lastChild.textContent = on ? 'Connected' : 'Not connected';
        line.textContent = on ? 'Connected just now.' : 'The computer disconnected. Run ov-connect again to bring it back.';
    }
    function ask() {
        if (Date.now() - started > 10 * 60 * 1000) return;
        if (document.hidden) { setTimeout(ask, 4000); return; }
        fetch('/api/v1/shares/' + encodeURIComponent(id), { credentials: 'same-origin', headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && j.share && j.share.status === 'active') show(!!j.share.connected); })
            .catch(function () { /* the next ask tries again */ })
            .then(function () { setTimeout(ask, 4000); });
    }
    setTimeout(ask, 4000);
})();

/* The inspector (CON-8): new requests through the share appear at the top of the list, every 3 seconds while the page
   is visible, for up to 30 minutes; a request still open is asked about again until it ends. The rows match
   server/views/index.js requestRow. */
(function () {
    'use strict';
    var box = document.querySelector('[data-cn-reqs]');
    if (!box || !window.fetch) return;
    var id = box.getAttribute('data-cn-reqs');
    var list = box.querySelector('[data-cn-reqs-list]');
    var empty = box.querySelector('[data-cn-reqs-empty]');
    var KEEP = 100;
    var ERRORS = { local_refused: 'nothing listening', timeout: 'timed out', visitor_gone: 'visitor left', too_large: 'too large', tunnel_closed: 'dropped', bad_status: 'odd answer', bad_headers: 'odd answer', local_error: 'app stopped' };
    var started = Date.now();
    function size(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function row(q) {
        var tone = q.open ? 'open' : q.error && !q.status ? 'err' : q.status >= 500 ? 's5' : q.status >= 400 ? 's4' : q.status >= 300 ? 's3' : 's2';
        var li = el('li', 'cn-req is-' + tone);
        li.setAttribute('data-seq', q.seq);
        li.appendChild(el('span', 'cn-req-badge', q.open ? (q.ws ? 'open' : '…') : q.status ? String(q.status) : (ERRORS[q.error] || q.error || '?')));
        var line = el('code', 'cn-req-line');
        line.appendChild(el('b', null, q.ws ? 'WS' : q.method));
        line.appendChild(document.createTextNode(' ' + q.path));
        li.appendChild(line);
        var meta = [q.ms != null ? q.ms + ' ms' : null, q.in ? size(q.in) + ' in' : null, q.out ? size(q.out) + ' out' : null,
            q.error && q.status ? (ERRORS[q.error] || q.error) : null, q.who ? '@' + q.who : null].filter(Boolean).join(' · ');
        li.appendChild(el('span', 'cn-req-meta', meta));
        var t = el('time', null, String(q.at).slice(11, 19));
        t.setAttribute('datetime', q.at);
        li.appendChild(t);
        return li;
    }
    function seqs() { return Array.prototype.map.call(list.children, function (li) { return Number(li.getAttribute('data-seq')) || 0; }); }
    function after() {
        // The oldest request still open is asked about again, so it ends on the page too.
        var open = Array.prototype.filter.call(list.children, function (li) { return li.classList.contains('is-open'); })
            .map(function (li) { return Number(li.getAttribute('data-seq')) || 0; });
        if (open.length) return Math.min.apply(null, open) - 1;
        var all = seqs();
        return all.length ? Math.max.apply(null, all) : 0;
    }
    function apply(items) {
        // Newest first from the API; inserted oldest first so the newest ends on top.
        items.slice().reverse().forEach(function (q) {
            var old = list.querySelector('[data-seq="' + q.seq + '"]');
            var li = row(q);
            if (old) { list.replaceChild(li, old); return; }
            li.classList.add('is-new');
            list.insertBefore(li, list.firstChild);
        });
        while (list.children.length > KEEP) list.removeChild(list.lastChild);
        if (empty) empty.hidden = list.children.length > 0;
    }
    function ask() {
        if (Date.now() - started > 30 * 60 * 1000) return;
        if (document.hidden) { setTimeout(ask, 3000); return; }
        fetch('/api/v1/shares/' + encodeURIComponent(id) + '/requests?after=' + after(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { if (j && Array.isArray(j.requests) && j.requests.length) apply(j.requests); })
            .catch(function () { /* the next ask tries again */ })
            .then(function () { setTimeout(ask, 3000); });
    }
    setTimeout(ask, 3000);
})();
