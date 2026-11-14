// HUD mode (Serdar). Contract (CLAUDE.md, "Sayfa yerleşimi"):
//   export function initHUD(state, el)   // el = #hud from index.html, starts hidden
//   - H key and the 'hud:toggle' event (header button) toggle the HUD.
//   - On open/close the HUD sets document.body.dataset.mode = 'hud' / 'map'.
//   - 'stop:select' updates the next stop.
//   - Any state field may be null; the HUD must never throw.
//   - Styles live in hud.css (linked by index.html), every selector starts with #hud.
// Returns a small controller ({toggle, setTime, render}) for the later simulation clock.

import {
  compass, distanceM, evaDose, evalAlerts, evaStatus, fmtDuration, fmtLmst,
  parseUtc, sunAt,
} from './model.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function panel(title) {
  const box = h('section', 'hud-panel');
  box.append(h('h2', 'hud-panel__title', title));
  const body = h('div', 'hud-panel__body');
  box.append(body);
  return { box, body };
}

function row(body, label, value, note) {
  const r = h('div', 'hud-row');
  r.append(h('span', 'hud-row__label', label));
  const v = h('span', 'hud-row__value', value);
  if (note) v.append(h('span', 'hud-tag', note));
  r.append(v);
  body.append(r);
  return r;
}

function fmtNum(v, digits = 0, unit = '') {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';
}

function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// Default snapshot time: EVA start, else the highest Sun in sun.json.
function defaultTime(state) {
  const evaStart = parseUtc(state?.eva?.start_utc);
  if (evaStart) return evaStart;
  const rows = state?.sun?.rows;
  if (Array.isArray(rows) && rows.length) {
    const top = rows.reduce((a, b) => (b.sun_el > a.sun_el ? b : a));
    return parseUtc(top.utc);
  }
  return null;
}

export function initHUD(state, el) {
  if (!el) {
    console.error('[hud] initHUD: no container element');
    return null;
  }
  state = state || {};

  let time = defaultTime(state);
  let selectedStop = Array.isArray(state.stops) && state.stops.length ? state.stops[0] : null;
  let open = !el.hidden;

  // el is the #hud box (fixed overlay from base.css); we only fill it.
  const root = h('div', 'hud');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Astronaut HUD');
  el.replaceChildren(root);

  function safe(name, fn, body) {
    try {
      fn();
    } catch (err) {
      console.error(`[hud] ${name} panel failed`, err);
      body.replaceChildren(h('p', 'hud-muted', 'Unavailable'));
    }
  }

  function render() {
    const s = sunAt(state.sun, time);
    const eva = state.eva;
    const status = evaStatus(eva, time);
    const dose = evaDose(state.radiation, eva);

    // --- top bar
    const bar = h('header', 'hud-bar');
    const left = h('div', 'hud-bar__group');
    left.append(h('span', 'hud-bar__title', 'MARSWALK HUD'));
    left.append(h('span', 'hud-bar__clock', `LMST ${fmtLmst(s?.lmst_min)}`));
    left.append(h('span', 'hud-muted hud-bar__snap',
      time ? `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'No time data'));
    const right = h('div', 'hud-bar__group');
    if (eva?.start_lmst && eva?.end_lmst) {
      right.append(h('span', 'hud-muted', `EVA window ${eva.start_lmst}–${eva.end_lmst}`));
    } else {
      right.append(h('span', 'hud-muted', 'EVA window —'));
    }
    if (status) {
      const label = {
        before: `opens in ${fmtDuration(status.min)}`,
        open: `${fmtDuration(status.min)} left`,
        closed: `closed ${fmtDuration(status.min)} ago`,
      }[status.state];
      right.append(h('span', `hud-pill hud-pill--${status.state}`, label));
    }
    bar.append(left, right);

    // --- alerts
    const metrics = {
      sun_el: s?.sun_el ?? null,
      earth_el: s?.earth_el ?? null,
      light_time_min: s?.light_time_min ?? null,
      o2_used_pct: state.summary?.o2_used_pct ?? null,
      dose_mSv: dose?.mSv ?? null,
      max_slope_deg: state.summary?.max_slope_deg ?? null,
      eva_state: status?.state ?? null,
      radiation_status: state.radiation?.status ?? null,
      radiation_message: state.radiation?.message ?? null,
    };
    const alertBox = h('div', 'hud-alerts');
    alertBox.setAttribute('aria-live', 'polite');
    for (const a of evalAlerts(state.alerts, metrics)) {
      alertBox.append(h('div', `hud-alert hud-alert--${a.level}`, a.text));
    }

    // --- life support
    const life = panel('Life support');
    safe('life', () => {
      const used = state.summary?.o2_used_pct;
      if (Number.isFinite(used)) {
        const left = Math.max(0, 100 - used);
        row(life.body, 'O₂ planned use', fmtNum(used, 0, '%'));
        row(life.body, 'O₂ at return', fmtNum(left, 0, '%'));
        const meter = h('div', 'hud-meter');
        const fill = h('div', 'hud-meter__fill');
        fill.style.width = `${left}%`;
        meter.append(fill);
        life.body.append(meter);
      } else {
        row(life.body, 'O₂', '—');
        life.body.append(h('p', 'hud-muted', 'Waiting for route summary'));
      }
      row(life.body, 'EVA dose', dose ? `${dose.mSv.toFixed(3)} mSv` : '—', dose?.estimated ? 'est.' : null);
      if (dose && dose.multiplier !== 1) row(life.body, 'Solar event', `×${dose.multiplier}`);
      if (Number.isFinite(eva?.duration_min)) row(life.body, 'EVA length', fmtDuration(eva.duration_min));
    }, life.body);

    // --- next stop
    const stopP = panel('Next stop');
    safe('stop', () => {
      if (!selectedStop) {
        stopP.body.append(h('p', 'hud-muted', 'No stop selected'));
        return;
      }
      stopP.body.append(h('p', 'hud-stop__name', selectedStop.name || selectedStop.id || 'Stop'));
      const d = distanceM(state.area?.habitat, selectedStop.coord);
      row(stopP.body, 'From habitat', fmtDist(d));
      if (selectedStop.science) {
        stopP.body.append(h('p', 'hud-stop__note', selectedStop.science));
      }
    }, stopP.body);

    // --- sun
    const sunP = panel('Sun');
    safe('sun', () => {
      row(sunP.body, 'Elevation', fmtNum(s?.sun_el, 1, '°'));
      row(sunP.body, 'Azimuth', s ? `${fmtNum(s.sun_az, 0, '°')} ${compass(s.sun_az)}` : '—');
    }, sunP.body);

    // --- comms
    const comms = panel('Earth link');
    safe('comms', () => {
      const up = Number.isFinite(s?.earth_el) ? s.earth_el >= 0 : null;
      row(comms.body, 'Earth elevation', fmtNum(s?.earth_el, 1, '°'));
      row(comms.body, 'Direct link', up == null ? '—' : up ? 'Line of sight' : 'Below horizon');
      row(comms.body, 'One-way delay', fmtNum(s?.light_time_min, 1, ' min'));
      if (Number.isFinite(s?.light_time_min)) {
        row(comms.body, 'Round trip', fmtNum(2 * s.light_time_min, 1, ' min'));
      }
    }, comms.body);

    const grid = h('div', 'hud-grid');
    const colL = h('div', 'hud-col hud-col--left');
    const colR = h('div', 'hud-col hud-col--right');
    colL.append(life.box);
    colR.append(stopP.box);
    const bottom = h('div', 'hud-bottom');
    bottom.append(sunP.box, comms.box);
    grid.append(colL, colR);

    root.replaceChildren(bar, alertBox, grid, bottom);
  }

  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open;
    el.hidden = !open;
    document.body.dataset.mode = open ? 'hud' : 'map'; // only the HUD writes this
    if (open) render();
  }

  document.addEventListener('hud:toggle', () => toggle());
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'h' || e.key === 'H') toggle();
  });
  document.addEventListener('stop:select', (e) => {
    if (!e.detail) return;
    selectedStop = e.detail;
    if (open) render();
  });

  return {
    toggle,
    render: () => open && render(),
    setTime(t) {
      time = t instanceof Date ? t : parseUtc(t);
      if (open) render();
    },
    get time() { return time; },
  };
}
