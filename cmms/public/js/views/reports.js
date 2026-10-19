// Reports & exports (CSV / Excel, PDF via print).
import { h, mount, api, can, fmt, simpleTable, pageHead, filterBar, download, act, state } from '../ui.js';

export async function list(el) {
  const reps = await api('/reports');
  mount(el, pageHead('Reports & exports', 'Every report supports date range and project/site filters, CSV and Excel export, and printing to PDF'),
    h('div', { class: 'grid three' }, ...reps.map(r => h('a', { class: 'panel', href: `#/reports/${r.id}`, style: { display: 'block', textDecoration: 'none', color: 'inherit' } },
      h('b', null, r.title), h('div', { class: 'sub' }, r.dated ? 'Date range + site' : 'Current snapshot + site')))));
}

function cell(v, type) {
  if (v == null || v === '') return '—';
  if (type === 'date') return fmt.date(v);
  if (type === 'datetime') return fmt.dt(v);
  if (type === 'money') return fmt.money(v);
  if (type === 'number') return fmt.num(v, 2);
  return String(v);
}

export async function report(el, id, q) {
  const reps = await api('/reports');
  const meta = reps.find(r => r.id === id);
  if (!meta) throw new Error('Report not available for your role');
  const extras = meta.params.map(p => h('div', { class: 'field' }, h('label', null, p.label), h('select', { name: p.key }, ...p.options.map(o => h('option', { value: o }, o.replace('_', ' '))))));
  const body = h('div');
  const bar = filterBar({ dates: meta.dated, category: true, initial: q, extras, onChange: f => load(f) });
  const exp = fmtName => h('button', { class: 'btn', onclick: e => act(e.currentTarget, () => download(`/reports/${id}`, { ...bar.values(), format: fmtName })) }, `⬇ ${fmtName.toUpperCase()}`);
  mount(el, pageHead(meta.title, state.meta.company, can('report.export') || (id === 'finance_export' && can('cost.export')) ? [exp('xlsx'), exp('csv')] : null, h('button', { class: 'btn', onclick: () => window.print() }, '⎙ Print / PDF')), bar, body);
  async function load(f) {
    mount(body, h('div', { class: 'loading' }, 'Running report…'));
    const r = await api(`/reports/${id}`, { query: f });
    mount(body, h('div', { class: 'panel' },
      h('div', { class: 'sub' }, `${r.period ? `Period ${fmt.date(r.period.from)} – ${fmt.date(r.period.to)} · ` : 'Current snapshot · '}${f.site_id ? state.meta.sites.find(s => String(s.id) === String(f.site_id)).name : 'All permitted sites'} · generated ${fmt.dt(r.generated_at)} (Asia/Manila) · ${r.rows.length} rows`),
      r.notes.length ? h('ul', { class: 'sub' }, ...r.notes.map(n => h('li', null, n))) : null,
      simpleTable(r.columns.map(c => ({ label: c.label, num: c.type === 'number' || c.type === 'money', render: row => cell(row[c.key], c.type) })), r.rows, { empty: 'No records for these filters' })));
  }
  load(bar.values());
}
