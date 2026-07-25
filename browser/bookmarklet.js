/**
 * Philomatic capture bookmarklet (implementation_plan_browser.md §4, milestone 2) — readable
 * source. Grabs the current page's URL + title, POSTs to the local ingest service, and toasts
 * the result. Drag the minified one-liner in browser/install.html to your bookmarks bar.
 *
 * Runs in the VISITED page's origin, so it relies on the service's CORS headers. A page with a
 * strict Content-Security-Policy can block the fetch — that's the known Stage-0 limit the
 * Stage-1 extension removes (§2.6).
 *
 * Configure the endpoint by editing PORT (and TOKEN, if the service runs with --token).
 */
(function () {
  var PORT = 4321;
  var TOKEN = ''; // set to match the service's --token / INGEST_TOKEN, or leave ''
  // 127.0.0.1, not "localhost": localhost often resolves to ::1 (IPv6) but the server binds IPv4.

  function toast(text, ok) {
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:fixed;z-index:2147483647;top:16px;right:16px;max-width:320px;' +
      'padding:10px 14px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;' +
      'color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);background:' +
      (ok ? '#1f883d' : '#cf222e') + ';';
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3200);
  }

  var headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['X-Ingest-Token'] = TOKEN;
  var BASE = 'http://127.0.0.1:' + PORT;

  function post(path, body) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    });
  }

  var selection = String(window.getSelection ? window.getSelection() : '').trim().slice(0, 2000);

  // Always remember the page (source + STAGED). If text is highlighted, also capture it as a
  // snippet against the same URL — one button covers both the source and the annotation loop.
  post('/ingest', { url: location.href, title: document.title, tags: [] })
    .then(function (res) {
      if (!res.ok) throw new Error(res.j.error || 'ingest error');
      if (!selection) return { j: { created: false } };
      return post('/snippet', { url: location.href, text: selection });
    })
    .then(function (snip) {
      var msg = selection
        ? 'Philomatic saved a highlight' + (snip && snip.j && snip.j.created === false ? ' (already had it)' : '')
        : 'Philomatic remembered this source';
      toast(msg, true);
    })
    .catch(function (e) {
      toast('Philomatic: ' + e.message, false);
    });
})();
