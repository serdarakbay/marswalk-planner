// HUD mode (Serdar). Contract (CLAUDE.md, page layout section):
//   export function initHUD(state, el)   // el = #hud-root from index.html, starts hidden
//   - H key and the 'hud:toggle' event (header button) toggle the HUD.
//   - On open/close the HUD sets document.body.dataset.mode = 'hud' / 'map'.
//   - 'stop:select' updates the next stop.
//   - Emits 'hud:time' {active, playing, utc, elapsed_min, coord, d_m, storm, shelter} on every
//     simulated minute, seek, pause, open/close and storm toggle, so the map can move an
//     astronaut marker (storm / shelter are extra fields the map may use to highlight a shelter).
//   - "Storm replay" button or ?radiation=replay in the URL (only when radiation.json has a
//     replay block): status, event_multiplier and message come from radiation.replay, the top
//     bar shows "REPLAY: <date>", and the HUD raises a danger alert with the nearest shelter.
//   - Any state field may be null; the HUD must never throw.
//   - The HUD loads its own stylesheet (hud.css); every selector there starts with #hud-root.
// Simulation clock: play / pause, speed and a time slider move the HUD through the EVA.
// Returns a controller ({toggle, setTime, render, clock}).

import {
  activityFraction, compass, distanceM, doseAt, effectiveRadiation, evaDose, evalAlerts, evaStatus, radiationAt,
  fmtDuration, fmtLmst, nearestShelter, nextStop, o2At, parseUtc, routeState, routeTimeline, safetyAt,
  stopSchedule, sunAt,
} from './model.js';
import { createClock, SPEEDS } from './sim.js';

// The slider covers the EVA window plus this margin on both sides (UI only).
const SIM_MARGIN_MIN = 30;

const CSS_URL = new URL('../../css/hud.css', import.meta.url).href;

// index.html does not link hud.css; the HUD adds it once, after base.css.
function ensureStylesheet() {
  const already = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === CSS_URL);
  if (already) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  document.head.appendChild(link);
}

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

// '2024-05-20' -> '20 May 2024' (UI text is English)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso);
}

function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// Simulation range: EVA window +/- margin, clamped to sun.json; else all of sun.json.
// Initial time: EVA start, else the highest Sun.
function simRange(state) {
  const rows = Array.isArray(state?.sun?.rows) ? state.sun.rows : [];
  const first = rows.length ? parseUtc(rows[0].utc) : null;
  const last = rows.length ? parseUtc(rows[rows.length - 1].utc) : null;
  const evaStart = parseUtc(state?.eva?.start_utc);
  const evaEnd = parseUtc(state?.eva?.end_utc);
  const pad = SIM_MARGIN_MIN * 60000;
  if (evaStart && evaEnd) {
    const start = new Date(Math.max(evaStart.getTime() - pad, first ? first.getTime() : -Infinity));
    const end = new Date(Math.min(evaEnd.getTime() + pad, last ? last.getTime() : Infinity));
    return { start, end, initial: evaStart };
  }
  if (first && last) {
    const top = rows.reduce((a, b) => (b.sun_el > a.sun_el ? b : a));
    return { start: first, end: last, initial: parseUtc(top.utc) };
  }
  return null;
}

export function initHUD(state, el) {
  if (!el) {
    console.error('[hud] initHUD: no container element');
    return null;
  }
  ensureStylesheet();
  state = state || {};

  const range = simRange(state);
  let time = range?.initial ?? null;
  // Manual pick from the map ('stop:select'); cleared when the clock starts playing.
  let pinnedStop = null;
  // Demo: radiation.json "replay" scenario (20 May 2024 solar storm) switched on/off from the sim bar
  // ?radiation=replay in the page URL starts with the replay on (for the presentation link).
  const hasReplay = Boolean(state.radiation?.replay);
  let storm = false;
  try {
    storm = hasReplay && new URLSearchParams(location.search).get('radiation') === 'replay';
  } catch { /* no location (tests) */ }
  const fallbackStop = Array.isArray(state.stops) && state.stops.length ? state.stops[0] : null;
  let open = !el.hidden;

  // Route timing (null until Demir's route.geojson / summary.json exist)
  let timeline = null;
  let schedule = [];
  try {
    timeline = routeTimeline(state.route, state.summary);
    schedule = stopSchedule(timeline, state.stops);
  } catch (err) {
    console.error('[hud] route timeline failed', err);
  }
  const evaStart = parseUtc(state.eva?.start_utc);
  const activeMin = timeline?.total_min ?? state.eva?.duration_min ?? null;

  // Look: visor by default (the challenge describes the HUD as projected on the helmet visor).
  // ?hud=plain in the page URL switches to the plain/modern look.
  let look = 'visor';
  try {
    if (new URLSearchParams(location.search).get('hud') === 'plain') look = 'plain';
  } catch { /* no location (tests) */ }
  if (look === 'visor') el.dataset.look = 'visor';

  // el is the #hud-root box (fixed overlay from base.css); we only fill it.
  const root = h('div', 'hud');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Astronaut HUD');
  const content = h('div', 'hud-content');
  root.append(content);
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
    const elapsed = evaStart && time ? (time - evaStart) / 60000 : null;
    const frac = activityFraction(elapsed, activeMin);
    // Live status follows the simulation clock; the replay (storm) overrides it when on.
    const rad = effectiveRadiation(radiationAt(state.radiation, time), storm);
    const dose = evaDose(rad, eva, timeline?.total_min, state.summary);
    const doseNow = doseAt(dose, frac);
    const o2 = o2At(state.summary, frac);
    // Inside the habitat before the EVA starts and after the route ends (known only with route timing).
    // T+0 counts as inside: the astronaut is still at the habitat door.
    const atHabitat = timeline && frac != null ? frac >= 1 || elapsed <= 0 : null;
    const rs = atHabitat ? null : routeState(timeline, elapsed);
    const pos = rs?.coord ?? null;
    // Shelter / radio-shadow info only matters while outside.
    const safe1 = atHabitat ? null : safetyAt(state.safety, rs?.d_m);
    const isStorm = rad?.status === 'storm';
    const shelter = isStorm && !atHabitat
      ? nearestShelter(state.safety?.shelters, pos ?? state.area?.habitat) : null;

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
    if (rad?.replay_date) {
      right.prepend(h('span', 'hud-pill hud-pill--replay', `REPLAY: ${fmtDate(rad.replay_date)}`));
    }
    bar.append(left, right);

    // --- alerts
    // Walk-only metrics are null inside the habitat, so alerts.json rules about O2, dose or
    // the EVA clock ("shorten the stop") do not fire before leaving or after returning.
    const out = atHabitat !== true;
    const metrics = {
      sun_el: s?.sun_el ?? null,
      earth_el: s?.earth_el ?? null,
      light_time_min: s?.light_time_min ?? null,
      o2_used_pct: out ? o2?.used_pct ?? null : null,
      o2_remaining_pct: out ? o2?.remaining_pct ?? null : null,
      dose_mSv: out ? doseNow ?? null : null,
      elapsed_min: elapsed,
      eva_remaining_min: out && status?.state === 'open' ? status.min : null,
      max_slope_deg: state.summary?.max_slope_deg ?? null,
      slope_deg: rs?.slope_deg ?? null,
      comm_ok: typeof safe1?.comm_ok === 'boolean' ? safe1.comm_ok : null,
      shelter_min: Number.isFinite(safe1?.shelter_min) ? safe1.shelter_min : null,
      eva_state: status?.state ?? null,
      // back inside once the planned route is done (only known with route timing)
      at_habitat: atHabitat,
      radiation_status: rad?.status ?? null,
      radiation_message: rad?.message ?? null,
    };
    const alertBox = h('div', 'hud-alerts');
    alertBox.setAttribute('aria-live', 'polite');
    const alerts = evalAlerts(state.alerts, metrics);
    if (shelter) {
      const mins = Number.isFinite(safe1?.shelter_min) ? `${safe1.shelter_min.toFixed(1)} min, ` : '';
      alerts.unshift({
        id: 'hud-shelter', level: 'danger',
        text: `Take shelter: ${mins}${fmtDist(shelter.d_m)} ${compass(shelter.bearing_deg)}`,
      });
    }
    for (const a of alerts) {
      alertBox.append(h('div', `hud-alert hud-alert--${a.level}`, a.text));
    }

    // --- life support
    const life = panel('Life support');
    if (isStorm) life.box.classList.add('hud-panel--danger');
    safe('life', () => {
      if (o2) {
        row(life.body, 'O₂ remaining', fmtNum(o2.remaining_pct, 0, '%'), 'est.');
        const meter = h('div', 'hud-meter');
        const fill = h('div', 'hud-meter__fill');
        fill.style.width = `${o2.remaining_pct}%`;
        meter.append(fill);
        life.body.append(meter);
        row(life.body, 'O₂ at return', fmtNum(o2.at_return_pct, 0, '%'));
      } else {
        row(life.body, 'O₂', '—');
        life.body.append(h('p', 'hud-muted', 'Waiting for route summary'));
      }
      row(life.body, 'Dose so far', Number.isFinite(doseNow) ? `${doseNow.toFixed(3)} mSv` : '—',
        dose?.estimated ? 'est.' : null);
      if (dose) row(life.body, 'Planned dose', `${dose.mSv.toFixed(3)} mSv`);
      if (dose && dose.multiplier !== 1) {
        row(life.body, 'Solar event', `×${dose.multiplier}`, rad?.replay_date ? 'replay' : null);
      }
      if (shelter) {
        const mins = Number.isFinite(safe1?.shelter_min) ? `${safe1.shelter_min.toFixed(1)} min · ` : '';
        row(life.body, 'Shelter', `${mins}${fmtDist(shelter.d_m)} ${compass(shelter.bearing_deg)}`);
      } else if (isStorm && atHabitat) {
        row(life.body, 'Shelter', 'In habitat');
      } else if (Number.isFinite(safe1?.shelter_min)) {
        row(life.body, 'Nearest shelter', `${safe1.shelter_min.toFixed(1)} min`);
      }
      if (Number.isFinite(eva?.duration_min)) row(life.body, 'EVA length', fmtDuration(eva.duration_min));
    }, life.body);

    // --- next stop
    const stopP = panel('Next stop');
    safe('stop', () => {
      const scheduled = nextStop(schedule, elapsed);
      const stop = pinnedStop ?? scheduled?.stop ?? (schedule.length ? null : fallbackStop);
      if (!stop) {
        let msg = 'No stop selected';
        if (schedule.length) msg = frac >= 1 ? 'EVA complete: back at habitat' : 'All stops visited: return to habitat';
        stopP.body.append(h('p', 'hud-muted', msg));
        return;
      }
      stopP.body.append(h('p', 'hud-stop__name', stop.name || stop.id || 'Stop'));
      const from = pos ?? state.area?.habitat;
      row(stopP.body, pos ? 'Distance' : 'From habitat', fmtDist(distanceM(from, stop.coord)));
      const entry = schedule.find((x) => x.stop === stop || (stop.id != null && x.stop.id === stop.id));
      if (entry && Number.isFinite(elapsed)) {
        const leave = entry.t_leave ?? entry.t_min;
        if (elapsed < entry.t_min) {
          row(stopP.body, 'ETA', `in ${fmtDuration(entry.t_min - elapsed)}`);
        } else if (elapsed <= leave) {
          row(stopP.body, 'At stop', `leave in ${fmtDuration(leave - elapsed)}`);
        } else {
          row(stopP.body, 'ETA', 'passed');
        }
      } else if (!entry && schedule.length && stop === pinnedStop) {
        row(stopP.body, 'Route', 'not on planned route');
      }
      if (Number.isFinite(rs?.slope_deg)) row(stopP.body, 'Slope here', fmtNum(rs.slope_deg, 0, '°'));
      if (stop.science) {
        stopP.body.append(h('p', 'hud-stop__note', stop.science));
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
      if (typeof safe1?.comm_ok === 'boolean') {
        row(comms.body, 'Radio to habitat', safe1.comm_ok ? 'Clear' : 'Radio shadow');
      }
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

    content.replaceChildren(bar, alertBox, grid, bottom);
  }

  // --- simulation controls (built once; only their values change)
  const sim = h('div', 'hud-sim');
  const playBtn = h('button', 'hud-sim__play', 'Play');
  playBtn.type = 'button';
  const speedSel = h('select', 'hud-sim__speed');
  speedSel.setAttribute('aria-label', 'Simulation speed');
  for (const sp of SPEEDS) {
    const o = h('option', null, sp === 1 ? 'Real time' : `x${sp}`);
    o.value = String(sp);
    speedSel.append(o);
  }
  const slider = h('input', 'hud-sim__range');
  slider.type = 'range';
  slider.setAttribute('aria-label', 'Mission time');
  const simLabel = h('span', 'hud-sim__label');
  sim.append(playBtn, speedSel, slider, simLabel);
  const stormBtn = h('button', 'hud-sim__storm', 'Storm replay');
  stormBtn.type = 'button';
  stormBtn.title = 'Replay the 20 May 2024 solar storm (radiation.json)';
  stormBtn.setAttribute('aria-pressed', String(storm));
  if (hasReplay) sim.append(stormBtn);

  let lastMinute = null;
  let clock = null;

  // 'hud:time' tells the map where the astronaut is (approved by Ege, 2026-11-14).
  // detail: {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null}
  // coord and d_m are null until route.geojson exists. active is false when the HUD is closed.
  // Same rule as atHabitat in render(): inside at or before T+0 and after the route ends.
  function insideAt(elapsed) {
    if (!timeline || !Number.isFinite(elapsed)) return false;
    return elapsed <= 0 || elapsed >= timeline.total_min;
  }

  function emitTime() {
    const elapsed = evaStart && time ? (time - evaStart) / 60000 : null;
    let rs = null;
    try {
      rs = routeState(timeline, elapsed);
    } catch (err) {
      console.error('[hud] route state failed', err);
    }
    document.dispatchEvent(new CustomEvent('hud:time', {
      detail: {
        active: open,
        playing: Boolean(clock?.playing),
        utc: time ? time.toISOString() : null,
        elapsed_min: Number.isFinite(elapsed) ? Math.round(elapsed * 10) / 10 : null,
        coord: rs?.coord ? rs.coord.map((v) => Math.round(v * 1e6) / 1e6) : null,
        d_m: Number.isFinite(rs?.d_m) ? Math.round(rs.d_m) : null,
        storm,
        // No shelter to point at while the astronaut is inside (before T+0 or after the route)
        shelter: storm && rs?.coord && !insideAt(elapsed)
          ? nearestShelter(state.safety?.shelters, rs.coord)?.coord ?? null : null,
      },
    }));
  }

  function tLabel() {
    if (!time) return '—';
    if (!evaStart) return `${time.toISOString().slice(11, 16)} UTC`;
    const m = (time - evaStart) / 60000;
    return `T${m < 0 ? '-' : '+'}${fmtDuration(Math.abs(m))}`;
  }

  function syncControls() {
    if (!clock) return;
    playBtn.textContent = clock.playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', String(clock.playing));
    slider.value = String(Math.round((time - clock.start) / 60000));
    slider.setAttribute('aria-valuetext', tLabel());
    simLabel.textContent = tLabel();
  }

  if (range) {
    clock = createClock({
      start: range.start,
      end: range.end,
      initial: range.initial,
      onTick(t) {
        time = t;
        syncControls();
        // While playing, update once per simulated minute; seeks and pauses update at once.
        const minute = Math.floor(t.getTime() / 60000);
        if (minute !== lastMinute || !clock.playing) {
          lastMinute = minute;
          emitTime();
          if (open) render();
        }
      },
    });
    slider.min = '0';
    slider.max = String(Math.round((clock.end - clock.start) / 60000));
    slider.step = '1';
    speedSel.value = String(clock.speed);
    playBtn.addEventListener('click', () => {
      if (clock.playing) {
        clock.pause();
      } else {
        pinnedStop = null;
        clock.play();
      }
    });
    speedSel.addEventListener('change', () => clock.setSpeed(Number(speedSel.value)));
    stormBtn.addEventListener('click', () => {
      storm = !storm;
      stormBtn.setAttribute('aria-pressed', String(storm));
      emitTime();
      if (open) render();
    });
    slider.addEventListener('input', () => {
      clock.seek(clock.start.getTime() + Number(slider.value) * 60000);
    });
    root.append(sim);
    syncControls();
  }

  function toggle(force) {
    open = typeof force === 'boolean' ? force : !open;
    el.hidden = !open;
    document.body.dataset.mode = open ? 'hud' : 'map'; // only the HUD writes this
    if (open) render();
    else if (clock?.playing) clock.pause();
    emitTime();
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
    pinnedStop = e.detail;
    if (open) render();
  });

  return {
    toggle,
    render: () => open && render(),
    setTime(t) {
      const d = t instanceof Date ? t : parseUtc(t);
      if (clock) clock.seek(d);
      else { time = d; if (open) render(); }
    },
    get time() { return time; },
    get clock() { return clock; },
  };
}
