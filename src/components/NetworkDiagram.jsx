/* Carbon Charts network diagram with elkjs auto-layout.
   Uses the official diagram primitives (CardNode / Edge / markers)
   from @carbon/charts-react, laid out by elkjs. */
import { useState, useEffect, useMemo } from 'react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { path as d3Path } from 'd3-path';
import { Edge, ArrowRightMarker } from '@carbon/charts-react';

const elk = new ELK();

function edgePath(edge) {
  const s = edge.sections && edge.sections[0];
  if (!s) return '';
  const p = d3Path();
  p.moveTo(s.startPoint.x, s.startPoint.y);
  (s.bendPoints || []).forEach((b) => p.lineTo(b.x, b.y));
  p.lineTo(s.endPoint.x, s.endPoint.y);
  return p.toString();
}

export default function NetworkDiagram({
  nodes, links, nodeSize, renderNode,
  layout = 'layered', direction = 'RIGHT', height = 600, selected, onSelect, edgeColor,
}) {
  const [graph, setGraph] = useState(null);

  const sig = useMemo(
    () => nodes.map((n) => n.id).join(',') + '|' + links.map((l) => l.id).join(','),
    [nodes, links],
  );

  useEffect(() => {
    let alive = true;
    const g = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': layout,
        'elk.direction': direction,
        'elk.layered.spacing.nodeNodeBetweenLayers': '96',
        'elk.spacing.nodeNode': '40',
        'elk.padding': '[left=24, top=24, right=24, bottom=24]',
      },
      children: nodes.map((n) => ({ id: n.id, ...nodeSize(n) })),
      edges: links.map((l) => ({ id: l.id, sources: [l.source], targets: [l.target] })),
    };
    elk.layout(g).then((res) => { if (alive) setGraph(res); }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, layout, direction]);

  if (!graph) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cds-text-secondary)', fontSize: '.8125rem' }}>Computing layout…</div>;
  }

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const W = Math.max(graph.width || 0, 320);
  const H = graph.height || 400;

  return (
    <div style={{ height, overflow: 'auto', position: 'relative' }}>
      <svg width={W} height={H} style={{ display: 'block', minWidth: '100%' }}>
        <defs>
          <ArrowRightMarker id="nd-arrow" />
        </defs>
        {graph.edges.map((e) => (
          <Edge key={e.id} path={edgePath(e)} markerEnd="nd-arrow" variant="solid" color={edgeColor} />
        ))}
        {graph.children.map((c) => {
          const node = byId[c.id];
          return (
            <foreignObject key={c.id} x={c.x} y={c.y} width={c.width} height={c.height} style={{ overflow: 'visible' }}>
              <div
                style={{ width: c.width, height: c.height, cursor: onSelect ? 'pointer' : 'default' }}
                onClick={onSelect ? () => onSelect(node) : undefined}
              >
                {renderNode(node, { selected: selected === c.id })}
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}
