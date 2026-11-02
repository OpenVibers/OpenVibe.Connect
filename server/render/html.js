'use strict';

/** Escaping and small building blocks for server-rendered pages. Everything dynamic goes through esc(). */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Raw(s);
function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
    return raw(out);
}
function render(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    return esc(v);
}

const code = (s) => html`<code>${s}</code>`;
const time = (iso) => (iso ? html`<time datetime="${iso}">${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time>` : '—');

function table(headers, rows, { cls = '', empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (typeof headers[i] === 'string' && headers[i] ? html`<td data-label="${headers[i]}">${c}</td>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
}

const notice = (text, kind = 'info') => html`<div class="notice ${kind}" role="status">${text}</div>`;
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

module.exports = { esc, html, raw, Raw, render, code, time, table, notice, badge };
