// HUD mode (Serdar). Contract (CLAUDE.md, page layout section):
//   export function initHUD(state, el)   // el = #hud-root from index.html, starts hidden
//   - H key and the 'hud:toggle' event (header button) toggle the HUD.
//   - On open/close the HUD sets document.body.dataset.mode = 'hud' / 'map'.
//   - 'stop:select' updates the next stop.
//   - Emits 'hud:time' {active, playing, utc, elapsed_min, coord, d_m, storm, shelter} on every
//     simulated minute, seek, pause, open/close and storm toggle, so the map can move an
//     astronaut marker (storm / shelter are extra fields the map may use to highlight a shelter).
//   - "Storm replay" button or ?radiation=replay in the URL (only when radiation.json has a
//     replay block): the storm hits (now, or 40 min into the walk from the URL), the astronaut
//     walks to the nearest shelter or the habitat, waits until it ends, then resumes the route.
//   - "Dust devil" button or ?hazard=dustdevil: a dust devil crosses the route; the astronaut
//     holds position until it has passed. Both scenarios are simulated in scenario.js.
//   - Any state field may be null; the HUD must never throw.
//   - The HUD loads its own stylesheet (hud.css); every selector there starts with #hud-root.
// Simulation clock: play / pause, speed and a time slider move the HUD through the EVA.
// Returns a controller ({toggle, setTime, render, clock}).

import {
  activityFraction, compass, distanceM, doseAt, effectiveRadiation, evaDose, evalAlerts, evaStatus, radiationAt,
  bearingDeg, FALLBACK, fmtDuration, fmtLmst, nearestShelter, nextStop, o2At, parseUtc, routeState,
  routeTimeline, safetyAt,
  stopSchedule, sunAt,
} from './model.js';
import { createClock, SPEEDS } from './sim.js';
import { isOutside, SCENARIO, simulate } from './scenario.js';

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
  // Dust devil demo (?hazard=dustdevil starts with it on)
  let dustOn = false;
  try {
    dustOn = new URLSearchParams(location.search).get('hazard') === 'dustdevil';
  } catch { /* no location (tests) */ }
  // When each scenario starts, in minutes after the EVA start (URL links use fixed demo times)
  let stormT0 = SCENARIO.STORM_URL_START_MIN;
  let dustT0 = SCENARIO.DUST_URL_START_MIN;
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

  // Step-by-step plan of the walk with the scenarios that are switched on (see scenario.js)
  let plan = null;
  function rebuildPlan() {
    plan = null;
    if (!timeline || !evaStart || !range) return;
    try {
      const rp = state.radiation?.replay || {};
      const base = Number.isFinite(state.radiation?.base_mSv_per_day)
        ? state.radiation.base_mSv_per_day : FALLBACK.rad_base_mSv_per_day;
      plan = simulate({
        tl: timeline,
        shelters: state.safety?.shelters,
        habitat: state.area?.habitat ?? timeline.coords[0],
        startMin: (range.start - evaStart) / 60000,
        endMin: (range.end - evaStart) / 60000,
        o2PerMin: Number.isFinite(state.summary?.o2_used_pct) ? state.summary.o2_used_pct / timeline.total_min : 0,
        o2StandPerMin: Number.isFinite(state.summary?.o2_standing_pct_per_min)
          ? state.summary.o2_standing_pct_per_min : FALLBACK.o2_standing_pct_per_min,
        doseBasePerMin: base / 1440,
        storm: storm && hasReplay ? {
          t0: stormT0,
          duration: Number.isFinite(rp.duration_min) ? rp.duration_min : 120,
          mult: Number.isFinite(rp.event_multiplier) ? rp.event_multiplier : 1,
          habitatFactor: Number.isFinite(rp.habitat_dose_factor) ? rp.habitat_dose_factor : 1,
        } : null,
        dust: dustOn ? { t0: dustT0 } : null,
      });
    } catch (err) {
      console.error('[hud] scenario plan failed', err);
      plan = null;
    }
  }
  rebuildPlan();

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
    // Scenario plan (null without route timing): where the astronaut is and what they are doing
    const p = plan ? plan.at(elapsed) : null;
    // Route progress in route minutes; equals elapsed unless a scenario delayed the walk
    const tau = p ? p.tau : elapsed;
    const frac = activityFraction(tau, activeMin);
    const stormOn = p ? p.stormOn : storm;
    // Live status follows the simulation clock; the replay (storm) overrides it while it lasts.
    const rad = effectiveRadiation(radiationAt(state.radiation, time), stormOn);
    const plannedDose = evaDose(radiationAt(state.radiation, time), eva, timeline?.total_min, state.summary);
    const dose = evaDose(rad, eva, timeline?.total_min, state.summary);
    const doseNow = p ? p.dose : doseAt(dose, frac);
    let o2 = null;
    if (p && Number.isFinite(state.summary?.o2_used_pct)) {
      const perMin = state.summary.o2_used_pct / timeline.total_min;
      // Once a storm or dust devil has started, the plan's final O2 includes the waits and detours;
      // before that the HUD cannot know it is coming, so it shows the plain route estimate.
      const nominal = p.o2 + perMin * Math.max(0, timeline.total_min - p.tau);
      const started = (plan.storm && elapsed >= plan.storm.t0) || (plan.dust && elapsed >= plan.dust.t0);
      const atReturn = started ? Math.max(plan.finalO2, nominal) : nominal;
      o2 = { used_pct: p.o2, remaining_pct: Math.max(0, 100 - p.o2), at_return_pct: Math.max(0, 100 - atReturn) };
    } else if (!p) {
      o2 = o2At(state.summary, frac);
    }
    // Inside the habitat: before the EVA, after the route, or back early because of the storm.
    // T+0 counts as inside: the astronaut is still at the habitat door.
    const atHabitat = p ? !isOutside(p.mode) : (timeline && frac != null ? frac >= 1 || elapsed <= 0 : null);
    const onRoute = p ? p.mode === 'route' || p.mode === 'hold' : !atHabitat;
    const rs = onRoute ? routeState(timeline, tau) : null;
    const pos = p ? (atHabitat ? null : p.coord) : rs?.coord ?? null;
    // Shelter / radio-shadow info only matters while walking the route.
    let safe1 = onRoute ? safetyAt(state.safety, rs?.d_m) : null;
    // safety.json built for another route: its row is far from here, so ignore it (stale data)
    if (safe1 && Number.isFinite(rs?.d_m) && Math.abs(safe1.d - rs.d_m) > 50) safe1 = null;
    const isStorm = rad?.status === 'storm';
    // Without a plan (no route timing) fall back to pointing at the nearest shelter
    const shelter = !p && isStorm && !atHabitat
      ? nearestShelter(state.safety?.shelters, pos ?? state.area?.habitat) : null;
    const refuge = p?.refuge ?? null;
    const stormLeft = plan?.storm && Number.isFinite(elapsed)
      ? plan.storm.t0 + plan.storm.duration - elapsed : null;

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
    if (storm && state.radiation?.replay?.date) {
      right.prepend(h('span', 'hud-pill hud-pill--replay', `REPLAY: ${fmtDate(state.radiation.replay.date)}`));
    }
    bar.append(left, right);

    // --- alerts
    // Walk-only metrics are null inside the habitat, so alerts.json rules about O2, dose or
    // the EVA clock ("shorten the stop") do not fire before leaving or after returning.
    const out = atHabitat !== true;
    const resting = p && (p.mode === 'sheltered' || !out);
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
      at_habitat: atHabitat,
      // "go to the shelter" rules make no sense once sheltered or inside
      radiation_status: resting ? null : rad?.status ?? null,
      radiation_message: rad?.message ?? null,
    };
    const alertBox = h('div', 'hud-alerts');
    alertBox.setAttribute('aria-live', 'polite');
    const alerts = evalAlerts(state.alerts, metrics);
    const scen = [];
    if (p) {
      const where = (to) => `${fmtDist(distanceM(p.coord, to))} ${compass(bearingDeg(p.coord, to))}`;
      if (p.mode === 'to_refuge' && refuge) {
        const mins = distanceM(p.coord, refuge.coord) / SCENARIO.WALK_M_PER_MIN;
        scen.push({ level: 'danger', text: refuge.habitat
          ? `Return to the habitat${refuge.o2Short ? ' (not enough O2 to wait out the storm)' : ''}: ${mins.toFixed(1)} min, ${where(refuge.coord)}`
          : `Take shelter: ${mins.toFixed(1)} min, ${where(refuge.coord)}` });
      } else if (p.mode === 'sheltered') {
        scen.push({ level: 'warn', text: `Sheltered (sky-view ${fmtNum(refuge?.svf, 2)}): storm ends in ${fmtDuration(stormLeft)}` });
      } else if (p.mode === 'home' && stormOn) {
        scen.push({ level: 'warn', text: `Back in the habitat: storm ends in ${fmtDuration(stormLeft)}` });
      } else if (p.mode === 'pre' && stormOn && elapsed > 0) {
        scen.push({ level: 'warn', text: `EVA on hold in the habitat: storm ends in ${fmtDuration(stormLeft)}` });
      } else if (p.mode === 'return' && p.resume) {
        scen.push({ level: 'info', text: `Storm over. Back to the route: ${where(p.resume.coord)}` });
      }
      if (p.mode === 'hold' && p.devil) {
        scen.push({ level: 'danger', text: `HOLD POSITION: dust devil crossing, ${where(p.devil)}` });
      } else if (p.devil && p.approaching && p.devilDist < SCENARIO.DUST_APPROACH_M) {
        scen.push(p.mode === 'route'
          ? { level: 'warn', text: `Dust devil ${where(p.devil)}, crossing the route ahead` }
          : p.mode === 'sheltered'
            ? { level: 'info', text: `Dust devil passing ${where(p.devil)}: stay in the shelter` }
            : { level: 'warn', text: `Dust devil ${where(p.devil)}: keep clear` });
      } else if (p.mode === 'route' && p.justCleared) {
        scen.push({ level: 'info', text: 'Dust devil passed. Resume the walk.' });
      }
    } else if (shelter) {
      const mins = Number.isFinite(safe1?.shelter_min) ? `${safe1.shelter_min.toFixed(1)} min, ` : '';
      scen.push({ level: 'danger', text: `Take shelter: ${mins}${fmtDist(shelter.d_m)} ${compass(shelter.bearing_deg)}` });
    }
    for (const a of [...scen, ...alerts]) {
      alertBox.append(h('div', `hud-alert hud-alert--${a.level}`, a.text));
    }

    // --- life support
    const life = panel('Life support');
    if (isStorm && out) life.box.classList.add('hud-panel--danger');
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
      if (p && plan.storm && elapsed >= plan.storm.t0) {
        row(life.body, 'No-shelter dose', `${plan.noShelterDose(elapsed).toFixed(3)} mSv`);
      } else if (plannedDose) {
        row(life.body, 'Planned dose', `${plannedDose.mSv.toFixed(3)} mSv`);
      }
      if (dose && dose.multiplier !== 1) {
        row(life.body, 'Solar event', `×${dose.multiplier}`, rad?.replay_date ? 'replay' : null);
      }
      if (p?.mode === 'to_refuge' && refuge) {
        const d = distanceM(p.coord, refuge.coord);
        row(life.body, refuge.habitat ? 'Habitat' : 'Shelter',
          `${(d / SCENARIO.WALK_M_PER_MIN).toFixed(1)} min · ${fmtDist(d)} ${compass(bearingDeg(p.coord, refuge.coord))}`);
      } else if (p?.mode === 'sheltered') {
        row(life.body, 'Shelter', `In shelter · svf ${fmtNum(refuge?.svf, 2)}`);
      } else if (shelter) {
        const mins = Number.isFinite(safe1?.shelter_min) ? `${safe1.shelter_min.toFixed(1)} min · ` : '';
        row(life.body, 'Shelter', `${mins}${fmtDist(shelter.d_m)} ${compass(shelter.bearing_deg)}`);
      } else if (isStorm && atHabitat) {
        row(life.body, 'Shelter', 'In habitat');
      } else if (Number.isFinite(safe1?.shelter_min)) {
        row(life.body, 'Nearest shelter', `${safe1.shelter_min.toFixed(1)} min`);
      }
      if (p && p.delay >= 0.5 && p.mode !== 'done') row(life.body, 'Delay', `+${fmtDuration(p.delay)}`);
      if (Number.isFinite(eva?.duration_min)) row(life.body, 'EVA length', fmtDuration(eva.duration_min));
    }, life.body);

    // --- next stop
    const stopP = panel('Next stop');
    safe('stop', () => {
      const scheduled = nextStop(schedule, tau);
      const stop = pinnedStop ?? scheduled?.stop ?? (schedule.length ? null : fallbackStop);
      if (!stop) {
        let msg = 'No stop selected';
        if (schedule.length) {
          if (p?.mode === 'home') msg = 'EVA ended early: back in the habitat';
          else msg = (p ? p.mode === 'done' : frac >= 1) ? 'EVA complete: back at habitat' : 'All stops visited: return to habitat';
        }
        stopP.body.append(h('p', 'hud-muted', msg));
        return;
      }
      stopP.body.append(h('p', 'hud-stop__name', stop.name || stop.id || 'Stop'));
      const from = pos ?? state.area?.habitat;
      row(stopP.body, pos ? 'Distance' : 'From habitat', fmtDist(distanceM(from, stop.coord)));
      const entry = schedule.find((x) => x.stop === stop || (stop.id != null && x.stop.id === stop.id));
      if (entry && Number.isFinite(tau)) {
        const leave = entry.t_leave ?? entry.t_min;
        if (p && !onRoute && out) {
          row(stopP.body, 'ETA', 'paused');
        } else if (tau < entry.t_min) {
          row(stopP.body, 'ETA', `in ${fmtDuration(entry.t_min - tau)}`);
        } else if (tau <= leave) {
          row(stopP.body, 'At stop', `leave in ${fmtDuration(leave - tau)}`);
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
  // Slider with a strip above it that marks the scenario events (storm, shelter, holds)
  const track = h('div', 'hud-sim__track');
  const eventsEl = h('div', 'hud-sim__events');
  eventsEl.setAttribute('aria-hidden', 'true');
  track.append(eventsEl, slider);
  sim.append(playBtn, speedSel, track, simLabel);
  const EVENT_LABELS = { storm: 'Solar storm', sheltered: 'In shelter', hold: 'Holding for dust devil', dust: 'Dust devil' };
  function renderEvents() {
    eventsEl.replaceChildren();
    if (!plan?.events?.length) return;
    const span = plan.endMin - plan.startMin;
    for (const ev of plan.events) {
      const a = Math.max(plan.startMin, ev.a);
      const b = Math.min(plan.endMin, ev.b);
      if (!(b > a)) continue;
      const seg = h('span', `hud-sim__event hud-sim__event--${ev.kind}`);
      seg.style.left = `${((a - plan.startMin) / span) * 100}%`;
      seg.style.width = `${Math.max(0.6, ((b - a) / span) * 100)}%`;
      seg.title = `${EVENT_LABELS[ev.kind] || ev.kind}: T+${Math.round(a)}–${Math.round(b)} min`;
      eventsEl.append(seg);
    }
  }
  const stormBtn = h('button', 'hud-sim__storm', 'Storm replay');
  stormBtn.type = 'button';
  stormBtn.title = 'Replay the 20 May 2024 solar storm (radiation.json)';
  stormBtn.setAttribute('aria-pressed', String(storm));
  if (hasReplay) sim.append(stormBtn);
  const dustBtn = h('button', 'hud-sim__storm hud-sim__dust', 'Dust devil');
  dustBtn.type = 'button';
  dustBtn.title = 'A dust devil crosses the route: hold position until it passes (scenario)';
  dustBtn.setAttribute('aria-pressed', String(dustOn));
  sim.append(dustBtn);

  let lastMinute = null;
  let clock = null;

  // 'hud:time' tells the map where the astronaut is (approved by Ege, 2026-11-14).
  // detail: {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null}
  // coord and d_m are null until route.geojson exists. active is false when the HUD is closed.
  // Extra fields: storm, shelter (refuge the astronaut is heading to or sits in, while the storm
  // is on), hazard ({coord, radius_m} of a dust devil, for the map) and mode (see scenario.js).
  function emitTime() {
    const elapsed = evaStart && time ? (time - evaStart) / 60000 : null;
    const p = plan ? plan.at(elapsed) : null;
    let coord = p ? p.coord : null;
    let dM = null;
    try {
      const tau = p ? p.tau : elapsed;
      const rs = routeState(timeline, tau);
      if (!p) coord = rs?.coord ?? null;
      if (!p || p.mode === 'route' || p.mode === 'hold') dM = rs?.d_m ?? null;
    } catch (err) {
      console.error('[hud] route state failed', err);
    }
    const r6 = (c) => c.map((v) => Math.round(v * 1e6) / 1e6);
    document.dispatchEvent(new CustomEvent('hud:time', {
      detail: {
        active: open,
        playing: Boolean(clock?.playing),
        utc: time ? time.toISOString() : null,
        elapsed_min: Number.isFinite(elapsed) ? Math.round(elapsed * 10) / 10 : null,
        coord: Array.isArray(coord) ? r6(coord) : null,
        d_m: Number.isFinite(dM) ? Math.round(dM) : null,
        storm: Boolean(p ? p.stormOn : storm),
        shelter: p?.stormOn && p.refuge && !p.refuge.habitat && isOutside(p.mode) ? r6(p.refuge.coord) : null,
        hazard: p?.devil ? { coord: r6(p.devil), radius_m: SCENARIO.DUST_RADIUS_M } : null,
        mode: p?.mode ?? null,
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
    // The storm / dust devil start "now" when switched on from the HUD
    const nowMin = () => (evaStart && time ? (time - evaStart) / 60000 : 0);
    stormBtn.addEventListener('click', () => {
      storm = !storm;
      if (storm) stormT0 = Math.max(0, nowMin());
      stormBtn.setAttribute('aria-pressed', String(storm));
      rebuildPlan();
      renderEvents();
      emitTime();
      if (open) render();
    });
    dustBtn.addEventListener('click', () => {
      dustOn = !dustOn;
      if (dustOn) dustT0 = Math.max(SCENARIO.STEP_MIN, nowMin());
      dustBtn.setAttribute('aria-pressed', String(dustOn));
      rebuildPlan();
      renderEvents();
      emitTime();
      if (open) render();
    });
    slider.addEventListener('input', () => {
      clock.seek(clock.start.getTime() + Number(slider.value) * 60000);
    });
    root.append(sim);
    renderEvents();
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
