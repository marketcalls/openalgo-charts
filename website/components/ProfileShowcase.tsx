import React from 'react';

const ROOT = '/openalgo-charts';
const IMAGE_ROOT = `${ROOT}/screenshots/market-profile`;
const DEMO = `${ROOT}/demos/market-profile/index.html`;
const THEMES = [
  { id: 'dark', name: 'Dark', description: 'Multicolour periods on a dark background.' },
  { id: 'blue', name: 'Blue', description: 'Navy background, purple letters and cyan volume.' },
  { id: 'graphite', name: 'Graphite', description: 'Charcoal, pale letters and muted cyan volume.' },
  { id: 'emerald', name: 'Emerald', description: 'Deep green, mint letters and gold reference lines.' },
  { id: 'ivory', name: 'Ivory', description: 'Warm light background, dark letters and blue-grey volume.' },
];

export function ProfileDemo() {
  return (
    <div className="oac-profile-demo">
      <div className="oac-profile-demo__head">
        <span>Six synthetic sessions · 2-point rows</span>
        <a href={`${DEMO}?theme=blue`} target="_blank" rel="noreferrer">Open full-size demo ↗</a>
      </div>
      <iframe src={`${DEMO}?theme=blue`} title="Interactive compact market profile demo" loading="lazy" />
    </div>
  );
}

export function ProfileThemeGallery() {
  return (
    <div className="oac-profile-gallery">
      {THEMES.map(theme => (
        <figure className="oac-profile-shot" key={theme.id}>
          <a href={`${IMAGE_ROOT}/${theme.id}.png`} target="_blank" rel="noreferrer" aria-label={`View full-resolution ${theme.name} screenshot`}>
            <img src={`${IMAGE_ROOT}/${theme.id}.png`} alt={`${theme.name} close-up of the newest daily TPO profile, with readable period letters, volume, open and latest-price markers; the session is split`} width={800} height={1320} loading="lazy" />
          </a>
          <figcaption>
            <strong>{theme.name}</strong>
            <p>{theme.description}</p>
            <a href={`${DEMO}?theme=${theme.id}`} target="_blank" rel="noreferrer">Try {theme.name} ↗</a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function ProfileSplitScreenshots() {
  return (
    <div className="oac-profile-details">
      {['packed', 'split'].map(mode => (
        <figure className="oac-profile-shot" key={mode}>
          <a href={`${IMAGE_ROOT}/${mode}-detail.png`} target="_blank" rel="noreferrer">
            <img src={`${IMAGE_ROOT}/${mode}-detail.png`} alt={`${mode === 'packed' ? 'Packed' : 'Split'} view of the same daily TPO profile, with lowercase o at the open and # at the latest price`} width={800} height={1320} loading="lazy" />
          </a>
          <figcaption><strong>{mode === 'packed' ? 'Packed: gaps closed' : 'Split: one column per period'}</strong></figcaption>
        </figure>
      ))}
    </div>
  );
}
