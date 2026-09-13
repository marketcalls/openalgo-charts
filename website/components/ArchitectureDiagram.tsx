import { useState } from 'react';

const diagram = '/openalgo-charts/architecture-diagram.svg?v=2.1.8';

export default function ArchitectureDiagram() {
  const [actualSize, setActualSize] = useState(false);
  return (
    <figure className="oac-architecture">
      <div className="oac-architecture__controls" role="group" aria-label="Diagram zoom">
        <span>Architecture · 2.1.8</span>
        <button type="button" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>Fit</button>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(true)}>Actual size</button>
        <a href={diagram} target="_blank" rel="noreferrer">Open SVG ↗</a>
      </div>
      <div className="oac-architecture__viewport" tabIndex={0} role="region" aria-label="Architecture diagram, scroll to explore at actual size">
        <img src={diagram} width={1600} height={1100}
          style={{ width: actualSize ? 1600 : '100%', maxWidth: 'none', height: 'auto' }}
          alt="OpenAlgo Charts 2.1.8: custom host or widget, seven capability layers, Canvas 2D and optional WebGL2 rendering, compact profiles, drawing model v2, and eight bundle tiers totalling 201.15 KB Brotli." />
      </div>
      <figcaption>Choose Actual size to read every label; scroll inside the diagram or open the vector image separately.</figcaption>
    </figure>
  );
}
