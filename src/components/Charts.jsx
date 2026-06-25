/* Carbon Charts wrappers. Data shape: [{ group, key, value }]. */
import {
  SimpleBarChart, LineChart, PieChart, DonutChart, ScatterChart,
  GroupedBarChart, StackedBarChart, AreaChart, WordCloudChart, GaugeChart, HeatmapChart,
} from '@carbon/charts-react';

const BASE = {
  toolbar: { enabled: false },
  legend: { enabled: false },
  theme: 'white',
  grid: { x: { enabled: false }, y: { enabled: true } },
};

const MINI = {
  toolbar: { enabled: false },
  legend: { enabled: false },
  theme: 'white',
  grid: { x: { enabled: false }, y: { enabled: false } },
  axes: {
    left: { mapsTo: 'value', visible: false },
    bottom: { mapsTo: 'key', scaleType: 'labels', visible: false },
  },
};

export function BarChart({ data, height = 140, color = '#0f62fe', group = 'Line', mini = false }) {
  const options = mini
    ? { ...MINI, color: { scale: { [group]: color } }, height: typeof height === 'number' ? `${height}px` : height }
    : {
        ...BASE,
        axes: { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } },
        color: { scale: { [group]: color } },
        height: typeof height === 'number' ? `${height}px` : height,
      };
  return <SimpleBarChart data={data} options={options} />;
}

export function TrendLine({ data, height = 140, color = '#0f62fe', group = 'p95 (ms)', mini = false }) {
  const base = mini ? MINI : BASE;
  const options = {
    ...base,
    points: { radius: mini ? 0 : 2 },
    axes: mini
      ? MINI.axes
      : { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } },
    color: { scale: { [group]: color } },
    curve: 'curveMonotoneX',
    height: typeof height === 'number' ? `${height}px` : height,
  };
  return <LineChart data={data} options={options} />;
}

/* ChartByType renders any supported chart from [{group,key,value}] data.
   Multi-series (multiple `group` values) is handled natively by carbon-charts. */
export function ChartByType({ type, data, height = 200, mini = false }) {
  const h = typeof height === 'number' ? `${height}px` : height;
  const cartesian = {
    ...(mini ? MINI : BASE),
    legend: { enabled: !mini },
    axes: mini ? MINI.axes : { left: { mapsTo: 'value' }, bottom: { mapsTo: 'key', scaleType: 'labels' } },
    height: h,
  };
  const circular = {
    toolbar: { enabled: false },
    legend: { enabled: !mini },
    theme: 'white',
    height: h,
    pie: { labels: { enabled: !mini } },
  };
  switch ((type || 'Bar').toLowerCase()) {
    case 'line':
    case 'spc':
      return <LineChart data={data} options={{ ...cartesian, points: { radius: mini ? 0 : 2 }, curve: 'curveMonotoneX' }} />;
    case 'area':
      return <AreaChart data={data} options={{ ...cartesian, curve: 'curveMonotoneX' }} />;
    case 'scatter':
      return <ScatterChart data={data} options={cartesian} />;
    case 'pie': {
      // Pie slices key on the dimension value (group=key, single value).
      const pie = data.map((d) => ({ group: d.key, value: d.value }));
      return <PieChart data={pie} options={circular} />;
    }
    case 'donut': {
      const donut = data.map((d) => ({ group: d.key, value: d.value }));
      return <DonutChart data={donut} options={{ ...circular, donut: { center: { label: '' } } }} />;
    }
    case 'grouped':
    case 'grouped bar':
      return <GroupedBarChart data={data} options={cartesian} />;
    case 'stacked':
    case 'stacked bar':
      return <StackedBarChart data={data} options={cartesian} />;
    case 'word cloud':
    case 'wordcloud': {
      // WordCloud wants [{word, value, group}]; key → word.
      const words = data.map((d) => ({ word: String(d.key), value: Number(d.value) || 0, group: d.group }));
      return <WordCloudChart data={words} options={{ toolbar: { enabled: false }, legend: { enabled: false }, theme: 'white', height: h, wordCloud: { fontSizeMapsTo: 'value', wordMapsTo: 'word' } }} />;
    }
    case 'gauge': {
      // Gauge shows one value: the first measure of the first row as a percentage.
      const v = Number(data[0]?.value) || 0;
      return <GaugeChart data={[{ group: 'value', value: v }]} options={{ toolbar: { enabled: false }, theme: 'white', height: h, gauge: { type: 'semicircular' } }} />;
    }
    case 'heatmap':
      return <HeatmapChart data={data} options={{ ...cartesian, axes: { left: { mapsTo: 'group', scaleType: 'labels' }, bottom: { mapsTo: 'key', scaleType: 'labels' } }, heatmap: { colorLegend: { title: 'value' } } }} />;
    case 'bar':
    default:
      // Multi-series → grouped bars; single series → simple bars.
      if (new Set(data.map((d) => d.group)).size > 1) {
        return <GroupedBarChart data={data} options={cartesian} />;
      }
      return <SimpleBarChart data={data} options={cartesian} />;
  }
}
