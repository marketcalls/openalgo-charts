import { useState } from 'react';

const diagram = '/openalgo-charts/architecture-diagram.svg?v=2.5.6-architecture-1';

export default function ArchitectureDiagram() {
  const [actualSize, setActualSize] = useState(false);
  return (
    <figure className="oac-architecture">
      <div className="oac-architecture__controls" role="group" aria-label="Diagram zoom">
        <span>Architecture · 2.5.6</span>
        <button type="button" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>Fit</button>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(true)}>Actual size</button>
        <a href={diagram} target="_blank" rel="noreferrer">Open SVG ↗</a>
      </div>
      <div className="oac-architecture__viewport" tabIndex={0} role="region" aria-label="Host boundary, base engine and optional tiers; scroll to explore at actual size">
        <img src={diagram} width={1280} height={1520}
          style={{ width: actualSize ? 1280 : '100%', maxWidth: 'none', height: 'auto' }}
          alt="OpenAlgo Charts 2.5.6 architecture: a custom host or widget owns data connections and application authority above the base engine's data-to-model-to-render pipeline, alerts, replay and linking, interaction, state and CSV. Eight optional tiers: indicators, draw, profile, transform, trade, workspace, WebGL and widget." />
      </div>
      <figcaption>The host supplies data and application authority; the base engine and eight optional tiers supply chart capabilities. Choose Actual size to read every label, scroll inside the diagram or open the vector image separately.</figcaption>
    </figure>
  );
}
