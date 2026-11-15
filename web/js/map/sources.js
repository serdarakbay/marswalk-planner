// sources.js (Ege): small "Data sources" button in the footer with a popover listing every dataset,
// what the app uses it for, and its status. The status comes from state, so a file that did not
// load shows "not loaded" and DONKI shows "Live" or "Replay" as it really is.

const SOURCES = [
  {
    name: 'Orbital imagery',
    credit: 'HiRISE, CTX, Viking, THEMIS, MOLA/HRSC via NASA Mars Trek',
    use: 'Base maps, thermal and elevation layers',
    url: 'https://trek.nasa.gov/mars/',
    status: (s) => s.layers && `${s.layers.length} layers`,
  },
  {
    name: 'Gale crater DEM, 1 m',
    credit: 'USGS Astrogeology',
    use: 'Slope, route, shelters, radio shadow, 3D terrain',
    url: 'https://astrogeology.usgs.gov/',
    status: (s) => s.summary && 'Real',
  },
  {
    name: 'Curiosity raw images',
    credit: 'NASA/JPL-Caltech, MSSS',
    use: 'Photos in the stop cards',
    url: 'https://mars.nasa.gov/msl/multimedia/raw-images/',
    status: (s) => s.images && `${s.images.length} photos`,
  },
  {
    name: 'Curiosity traverse',
    credit: 'NASA/JPL-Caltech (MMGIS)',
    use: "The rover's path on the map",
    url: 'https://mars.nasa.gov/maps/location/?mission=Curiosity',
    status: (s) => s.traverse && 'Real',
  },
  {
    name: 'REMS temperature',
    credit: 'CAB (CSIC-INTA), NASA/JPL-Caltech',
    use: 'EVA window (minimum temperature)',
    url: 'https://pds-atmospheres.nmsu.edu/',
    status: (s) => s.weather && 'Real',
  },
  {
    name: 'Sun and Earth position',
    credit: 'JPL Horizons, Mars24 algorithm',
    use: 'EVA window, HUD Sun and Earth link',
    url: 'https://ssd.jpl.nasa.gov/horizons/',
    status: (s) => s.sun && 'Real',
  },
  {
    name: 'Solar events',
    credit: 'NASA DONKI',
    use: 'Space weather check before the walk',
    url: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/',
    status: (s) => s.donki && (s.donki.mode === 'replay' ? 'Replay' : 'Live'),
  },
  {
    name: 'Storm of 20 May 2024',
    credit: 'Curiosity RAD, NASA/JPL-Caltech/SwRI',
    use: 'Solar storm replay and storm dose in the HUD',
    url: null,
    status: (s) => s.radiation && 'Replay',
  },
  {
    name: 'Geologic units',
    credit: 'USGS SIM 3292 (Tanaka et al., 2014)',
    use: 'Geology layer',
    url: 'https://doi.org/10.3133/sim3292',
    status: (s) => s.geology && 'Real',
  },
  {
    name: 'Team models',
    credit: 'O2, dose, walking speed, thresholds',
    use: 'Route budget, HUD alerts, shelter ranking',
    url: 'https://github.com/serdarakbay/marswalk-planner/blob/main/docs/story/assumptions.md',
    status: () => 'Computed',
  },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function initSources(state) {
  // A small link-style button at the end of the footer line, so the header keeps its room
  const footer = document.querySelector('.app-footer');
  if (!footer) throw new Error('footer not found');

  const button = el('button', 'sources-link', 'Data sources');
  button.type = 'button';
  button.id = 'sources-toggle';
  button.title = 'Data sources';

  const pop = el('div', 'sources-pop');
  pop.id = 'sources-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Data sources');

  pop.append(el('h2', 'sources-title', 'Data sources'));
  const list = el('ul', 'sources-list');
  for (const src of SOURCES) {
    let status = null;
    try { status = src.status(state) || null; } catch { status = null; }
    const li = el('li', 'sources-item');
    const head = el('div', 'sources-head');
    if (src.url) {
      const a = el('a', 'sources-name', src.name);
      a.href = src.url;
      a.target = '_blank';
      a.rel = 'noopener';
      head.append(a);
    } else {
      head.append(el('span', 'sources-name', src.name));
    }
    head.append(el('span', `sources-badge${status ? '' : ' is-missing'}`, status || 'not loaded'));
    li.append(head, el('div', 'sources-credit', src.credit), el('div', 'sources-use', src.use));
    list.append(li);
  }
  pop.append(list);
  document.body.append(pop);

  // Native popover (Esc and click outside close it); a plain hidden toggle where it is missing
  const native = 'popover' in HTMLElement.prototype;
  if (native) {
    pop.popover = 'auto';
    button.setAttribute('popovertarget', pop.id);
    pop.addEventListener('toggle', (e) => button.setAttribute('aria-pressed', String(e.newState === 'open')));
  } else {
    pop.hidden = true;
    button.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      button.setAttribute('aria-pressed', String(!pop.hidden));
    });
  }
  button.setAttribute('aria-pressed', 'false');

  // Close it when the HUD opens
  document.addEventListener('hud:toggle', () => {
    if (native) { try { pop.hidePopover(); } catch { /* already closed */ } } else { pop.hidden = true; }
    button.setAttribute('aria-pressed', 'false');
  });

  footer.append(' · ', button);
}
