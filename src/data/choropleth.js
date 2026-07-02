import { WORLD_TOPO } from './worldGeo.js';
import { FED_PLANTS } from './mockData.js';

// The footprint map lights up exactly the countries where a plant lives, so it
// stays in sync with the plant cards above. Each plant's region string ends in an
// ISO-ish country code (e.g. "Shanghai, CN"); map that to the world-atlas country.
const CC_TO_COUNTRY = {
  CN: { name: 'China', id: '156' },
  MY: { name: 'Malaysia', id: '458' },
  DE: { name: 'Germany', id: '276' },
  US: { name: 'United States of America', id: '840' },
};

// active pipelines ("18 / 18" -> 18, "— / 14" -> 0) gives the footprint some weight
const activePipes = (pipes) => {
  const n = parseInt(String(pipes).split('/')[0], 10);
  return Number.isFinite(n) ? n : 0;
};

// one row per plant country; countries with no plant are left out of the data and
// render in the basemap "no data" fill.
export const CHORO_DATA = FED_PLANTS.reduce((rows, p) => {
  const cc = (p.region.split(',').pop() || '').trim();
  const country = CC_TO_COUNTRY[cc];
  if (country) rows.push({ name: country.name, id: country.id, value: activePipes(p.pipes) });
  return rows;
}, []);

export const CHORO_OPTIONS = {
  height: '460px',
  toolbar: { enabled: false },
  theme: 'white',
  legend: { enabled: true },
  geoData: WORLD_TOPO,
  // flat "front-on" world instead of the default curved geoNaturalEarth1
  thematic: { projection: 'geoEquirectangular' },
  color: {
    gradient: { colors: ['#a6c8ff', '#4589ff', '#0f62fe', '#002d9c'] },
  },
  tooltip: { valueFormatter: (v) => (v == null ? 'n/a' : v + ' active pipelines') },
};
