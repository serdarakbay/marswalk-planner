// profile.js (Ege): elevation profile under the map.
//
//   export function initProfile(state, el, { onHover, label })   // el = #profile
//
// Returns the Chart (or null); call chart.detach() before drawing another profile in the same
// element: it removes the hud:time listener and destroys the chart.
// Draws summary.json profile[{d, z, slope}] with slope on a second axis, the route summary
// above it, radio-shadow bands from safety.json route[{d, comm_ok}], and a vertical line at
// the astronaut position from 'hud:time' (d_m). onHover(d) gets the hovered distance in
// metres, or null when the pointer leaves the chart.

/* global Chart */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// '#rrggbb' + alpha -> '#rrggbbaa'; other colour formats are returned unchanged
function withAlpha(color, alpha) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

function statsEl(summary) {
  const items = [
    ['Distance', summary.distance_m, (v) => `${(v / 1000).toFixed(2)} km`],
    ['Duration', summary.duration_min, fmtDuration],
    ['O2 used', summary.o2_used_pct, (v) => `${v.toFixed(1)}%`],
    ['Dose', summary.dose_mSv, (v) => `${v.toFixed(2)} mSv`],
    ['Max slope', summary.max_slope_deg, (v) => `${v.toFixed(1)}°`],
  ];
  const box = document.createElement('dl');
  box.className = 'profile-stats';
  for (const [label, value, fmt] of items) {
    if (!Number.isFinite(value)) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = fmt(value);
    box.append(dt, dd);
  }
  return box;
}

// Consecutive comm_ok=false samples -> [[d0, d1], ...]
function shadowRanges(route) {
  if (!Array.isArray(route)) return [];
  const pts = route.filter((p) => Number.isFinite(p?.d)).sort((a, b) => a.d - b.d);
  const ranges = [];
  pts.forEach((p, i) => {
    if (p.comm_ok !== false) return;
    const end = pts[i + 1]?.d ?? p.d;
    const last = ranges[ranges.length - 1];
    if (last && last[1] >= p.d) last[1] = end;
    else ranges.push([p.d, end]);
  });
  return ranges;
}

export function initProfile(state, el, { onHover, label } = {}) {
  const prof = state.summary?.profile;
  if (!Array.isArray(prof) || prof.length < 2) return null;
  if (typeof Chart === 'undefined') {
    console.warn('[profile] Chart.js not loaded; skipping the elevation profile');
    return null;
  }

  const colors = {
    text: cssVar('--color-text-muted'),
    grid: withAlpha(cssVar('--color-border'), 0.8),
    elevation: cssVar('--color-accent'),
    slope: cssVar('--color-sand'),
    shadow: cssVar('--color-danger'),
    astronaut: cssVar('--color-hud'),
  };
  const total = prof[prof.length - 1].d;
  const shadows = shadowRanges(state.safety?.route);
  let astronautD = null;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Elevation and slope along ${label || 'the planned route'}`);
  const wrap = document.createElement('div');
  wrap.className = 'profile-chart';
  wrap.append(canvas);
  el.replaceChildren(statsEl(state.summary), wrap);

  // Radio-shadow bands behind the lines
  const bands = {
    id: 'shadowBands',
    beforeDatasetsDraw(chart) {
      if (!shadows.length) return;
      const { ctx, chartArea: a, scales: { x } } = chart;
      ctx.save();
      ctx.fillStyle = withAlpha(colors.shadow, 0.18);
      for (const [d0, d1] of shadows) {
        const x0 = Math.max(a.left, x.getPixelForValue(d0));
        const x1 = Math.min(a.right, x.getPixelForValue(d1));
        if (x1 > x0) ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      }
      ctx.restore();
    },
  };

  // Astronaut position from the HUD clock
  const marker = {
    id: 'astronaut',
    afterDatasetsDraw(chart) {
      if (!Number.isFinite(astronautD)) return;
      const { ctx, chartArea: a, scales: { x } } = chart;
      const px = x.getPixelForValue(astronautD);
      if (px < a.left || px > a.right) return;
      ctx.save();
      ctx.strokeStyle = colors.astronaut;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, a.top);
      ctx.lineTo(px, a.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  // UI text is English: format numbers as 3,900 regardless of the browser locale
  Chart.defaults.locale = 'en-US';
  Chart.defaults.color = colors.text;
  Chart.defaults.font.family = cssVar('--font-sans');
  Chart.defaults.font.size = 11;

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Elevation',
          data: prof.map((p) => ({ x: p.d, y: p.z })),
          yAxisID: 'z',
          borderColor: colors.elevation,
          backgroundColor: withAlpha(colors.elevation, 0.22),
          borderWidth: 2,
          fill: 'start',
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: 'Slope',
          data: prof.map((p) => ({ x: p.d, y: p.slope })),
          yAxisID: 's',
          borderColor: colors.slope,
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: total,
          grid: { color: colors.grid },
          ticks: { callback: (v) => `${(v / 1000).toFixed(1)} km`, maxTicksLimit: 9 },
        },
        z: {
          position: 'left',
          grid: { color: colors.grid },
          title: { display: true, text: 'Elevation (m)' },
          ticks: { maxTicksLimit: 4 },
        },
        s: {
          position: 'right',
          min: 0,
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'Slope (°)' },
          ticks: { maxTicksLimit: 4 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${(items[0].parsed.x / 1000).toFixed(2)} km`,
            label: (item) => (item.dataset.yAxisID === 'z'
              ? `Elevation ${Math.round(item.parsed.y)} m`
              : `Slope ${item.parsed.y.toFixed(1)}°`),
          },
        },
      },
      onHover: (_evt, elements) => {
        if (elements.length) onHover?.(prof[elements[0].index].d);
      },
    },
    plugins: [bands, marker],
  });

  canvas.addEventListener('mouseleave', () => onHover?.(null));

  const onTime = (e) => {
    const { active, d_m: d } = e.detail || {};
    const next = active && Number.isFinite(d) ? d : null;
    if (next === astronautD) return;
    astronautD = next;
    chart.draw();
  };
  document.addEventListener('hud:time', onTime);
  chart.detach = () => {
    document.removeEventListener('hud:time', onTime);
    chart.destroy();
  };

  return chart;
}
