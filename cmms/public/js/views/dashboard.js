// Executive maintenance dashboard: KPIs with transparent formulas and drill-down, plus charts.
import { h, mount, api, state, fmt, modal, filterBar, pageHead, label, kv, errorBox, can } from '../ui.js';

const charts = [];
function chart(canvas, cfg) {
  const c = new window.Chart(canvas, { ...cfg, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, ...cfg.options } });
  charts.push(c); return c;
}
const COLORS = ['#1f4e79', '#c62828', '#c77700', '#1e8e3e', '#6a1b9a', '#00838f', '#607d8b', '#ad1457'];

function drillHref(d, f) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(d.query || {})) q.set(k, v);
  if (f.site_id) q.set('site_id', f.site_id);
  if (['availability', 'downtime', 'costs'].includes(d.view)) { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); }
  const path = { assets: '#/assets', workorders: '#/wo', availability: '#/reports/availability', downtime: '#/reports/downtime', costs: '#/costs', inventory: '#/inventory' }[d.view];
  return `${path}?${q}`;
}

function kpiModal(k, f) {
  const fmtVal = v => (v == null ? '—' : k.unit === 'PHP' ? fmt.money(v) : `${fmt.num(v, 2)}${k.unit === '%' ? ' %' : ''}`);
  modal({ title: k.label, wide: true, body: h('div', null,
    h('div', { class: 'formula' }, k.formula),
    kv([
      ['Value', k.value == null ? (k.note || 'No valid data') : fmtVal(k.value) + (k.unit && !['%', 'PHP'].includes(k.unit) ? ' ' + k.unit : '')],
      k.numerator != null ? [k.numerator_label || 'Numerator', fmt.num(k.numerator, 2)] : null,
      k.denominator != null ? [k.denominator_label || 'Denominator', fmt.num(k.denominator, 2)] : null,
      ['Measurement', k.basis === 'current' ? 'Current status (now)' : `Period ${f.from || ''} to ${f.to || ''}`],
      k.note ? ['Note', k.note] : null,
      k.rescheduled != null ? ['Rescheduled PMS in period', k.rescheduled] : null,
    ]),
    k.breakdown ? h('div', null, h('h3', null, 'Breakdown'), kv(Object.entries(k.breakdown).map(([a, b]) => [label(a), k.unit === 'PHP' ? fmt.money(b) : fmt.num(b, 2)]))) : null,
    k.exclusions ? h('div', null, h('h3', null, 'Rules, assumptions and exclusions'), h('ul', { class: 'sub' }, ...k.exclusions.map(x => h('li', null, x)))) : null,
  ), actions: [{ label: 'Close' }, k.drill ? { label: 'View underlying records →', class: 'btn-primary', onClick: () => { location.hash = drillHref(k.drill, f); } } : null].filter(Boolean) });
}

export async function view(el, q) {
  charts.splice(0).forEach(c => c.destroy());
  const kpiBox = h('div', { class: 'grid kpis' });
  const chartBox = h('div');
  const relBox = h('div');
  const bar = filterBar({ category: true, woType: true, initial: q, onChange: f => load(f),
    extras: [h('div', { class: 'field' }, h('label', null, ' '), h('button', { class: 'btn', onclick: () => window.print() }, '⎙ Print / PDF'))] });
  mount(el, pageHead('Executive maintenance dashboard', `${state.meta.company} · all figures computed from recorded data · click a KPI for its formula and records`), bar, kpiBox, relBox, chartBox);

  async function load(f) {
    mount(kpiBox, h('div', { class: 'loading' }, 'Calculating…'));
    try {
      const [d, c, r] = await Promise.all([api('/kpi/dashboard', { query: f }), api('/kpi/charts', { query: f }), api('/kpi/reliability', { query: f })]);
      mount(kpiBox, ...d.kpis.map(k => {
        const cls = k.severity || (k.key === 'availability' && k.value != null ? (k.value >= 90 ? 'ok' : k.value >= 80 ? 'warn' : 'bad') : k.key === 'pms_compliance' && k.value != null ? (k.value >= 90 ? 'ok' : k.value >= 75 ? 'warn' : 'bad') : (['overdue_pms', 'critical'].includes(k.key) && k.value ? 'bad' : ''));
        const val = k.value == null ? h('span', { class: 'muted', style: { fontSize: '1rem' } }, 'No data') : k.unit === 'PHP' ? fmt.money(k.value) : [fmt.num(k.value, 1), ' ', h('small', null, k.unit === '%' ? '%' : k.unit)];
        return h('div', { class: 'kpi ' + cls, tabindex: 0, role: 'button', onclick: () => kpiModal(k, { ...f, ...d.period }), onkeydown: e => { if (e.key === 'Enter') kpiModal(k, { ...f, ...d.period }); } },
          h('span', { class: 'basis' }, k.basis === 'current' ? 'now' : 'period'), h('div', { class: 'label' }, k.label), h('div', { class: 'value' }, val),
          h('div', { class: 'note' }, k.numerator != null && k.denominator != null && k.unit === '%' ? `${fmt.num(k.numerator, 1)} / ${fmt.num(k.denominator, 1)}` : (k.note || '')));
      }));
      const rel = [
        ['MTTR', r.mttr.value == null ? 'No closed repairs' : fmt.hours(r.mttr.value), `${r.mttr.denominator} repairs · labor ${fmt.hours(r.mttr.mean_labor_h)} · downtime ${fmt.hours(r.mttr.mean_downtime_h)} avg`, r.mttr],
        ['MTBF', r.mtbf.value == null ? (r.mtbf.note || '—') : fmt.hours(r.mtbf.value), `${fmt.num(r.mtbf.numerator, 0)} operating h / ${r.mtbf.denominator} failures`, r.mtbf],
        ['WO closure rate', r.closure_rate.value == null ? '—' : `${fmt.num(r.closure_rate.value)} %`, `${r.closure_rate.numerator} / ${r.closure_rate.denominator}`, r.closure_rate],
        ['Backlog', `${r.backlog.count} open`, `${fmt.hours(r.backlog.est_labor_h)} est. · ${r.backlog.waiting_parts} waiting parts`, { formula: 'Open work orders (all statuses except closed / cancelled / missed)', exclusions: Object.entries(r.backlog.aging).map(([a, b]) => `Aged ${a}: ${b}`).concat(Object.entries(r.backlog.by_priority).map(([a, b]) => `${label(a)}: ${b}`)) }],
      ];
      mount(relBox, h('h2', null, 'Reliability & workload'), h('div', { class: 'grid kpis' }, ...rel.map(([t, v, s, k]) => h('div', { class: 'kpi', role: 'button', onclick: () => kpiModal({ label: t, value: null, note: v, formula: k.formula, exclusions: k.exclusions, numerator: k.numerator, denominator: k.denominator, basis: 'period', drill: k.ids && k.ids.length ? { view: 'workorders', query: { ids: k.ids.join(',') } } : (t === 'Backlog' ? { view: 'workorders', query: { open: 1 } } : null) }, f) },
        h('div', { class: 'label' }, t), h('div', { class: 'value', style: { fontSize: '1.35rem' } }, v), h('div', { class: 'note' }, s)))));
      renderCharts(c, f);
    } catch (e) { mount(kpiBox, errorBox(e)); }
  }

  function renderCharts(c) {
    charts.splice(0).forEach(x => x.destroy());
    const box = (title, canvas, hint) => h('div', { class: 'panel' }, h('h3', null, title), hint ? h('div', { class: 'sub' }, hint) : null, h('div', { class: 'chart-box' }, canvas));
    const cv = () => h('canvas');
    const c1 = cv(), c2 = cv(), c3 = cv(), c4 = cv(), c5 = cv(), c6 = cv(), c7 = cv(), c8 = cv();
    mount(chartBox, h('h2', null, 'Trends and analysis'), h('div', { class: 'grid two' },
      box('Breakdown frequency by project/site', c1), box('Top equipment with recurring failures', c2, 'Click a bar to open the equipment'),
      box(`PMS vs corrective work orders (by ${c.granularity})`, c3), box(`Downtime trend (h, by ${c.granularity})`, c4),
      box('Equipment availability trend (%)', c5), c.cost_by_site ? box('Maintenance cost by project/site (₱)', c6) : null,
      box('Open work orders by status', c7), box('Open work order aging', c8)));
    const bar = (canvas, rows, lbl, color, opts = {}) => chart(canvas, { type: 'bar', data: { labels: rows.map(r => r.label), datasets: [{ label: lbl, data: rows.map(r => r.value), backgroundColor: color }] }, options: { indexAxis: opts.horizontal ? 'y' : 'x', plugins: { legend: { display: false } }, onClick: opts.onClick } });
    bar(c1, c.breakdowns_by_site, 'Breakdowns', COLORS[1]);
    bar(c2, c.top_failures, 'Breakdowns', COLORS[2], { horizontal: true, onClick: (e, els) => { if (els[0]) location.hash = `#/assets/${c.top_failures[els[0].index].asset_id}`; } });
    chart(c3, { type: 'bar', data: { labels: c.pms_vs_cm.map(r => r.label), datasets: [{ label: 'PMS', data: c.pms_vs_cm.map(r => r.PMS), backgroundColor: COLORS[0] }, { label: 'Corrective', data: c.pms_vs_cm.map(r => r.CM), backgroundColor: COLORS[4] }, { label: 'Other', data: c.pms_vs_cm.map(r => r.OTHER), backgroundColor: COLORS[6] }] }, options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } } });
    const cats = ['UNPLANNED', 'PLANNED', 'WAITING_PARTS', 'EXTERNAL', 'OTHER'];
    chart(c4, { type: 'bar', data: { labels: c.downtime_trend.map(r => r.label), datasets: cats.map((k, i) => ({ label: label(k), data: c.downtime_trend.map(r => r[k] || 0), backgroundColor: [COLORS[1], COLORS[0], COLORS[2], COLORS[4], COLORS[6]][i] })) }, options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } } });
    chart(c5, { type: 'line', data: { labels: c.availability_trend.map(r => r.label), datasets: [{ label: 'Availability %', data: c.availability_trend.map(r => r.value), borderColor: COLORS[3], backgroundColor: COLORS[3], tension: .2, spanGaps: true }] }, options: { scales: { y: { suggestedMin: 70, max: 100 } }, plugins: { legend: { display: false } } } });
    if (c.cost_by_site) bar(c6, c.cost_by_site, 'Cost', COLORS[5]);
    bar(c7, c.wo_by_status, 'Work orders', COLORS[0], { onClick: () => { location.hash = '#/wo?open=1'; } });
    bar(c8, Object.entries(c.wo_aging).map(([label, value]) => ({ label, value })), 'Open WOs', COLORS[2]);
  }
  await load(bar.values());
}
