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
