import React from 'react';
import { useConfig } from 'nextra-theme-docs';

const REPO = 'https://github.com/marketcalls/openalgo-charts';

const Logo = () => (
  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, letterSpacing: '-0.02em', fontSize: '1.05rem' }}>
    <img
      src="/openalgo-charts/openalgo-logo.svg"
      alt="OpenAlgo"
      width={24}
      height={24}
      style={{ borderRadius: 6, display: 'block' }}
    />
    OpenAlgo<span style={{ color: 'var(--oac-accent, #4f8cff)' }}>Charts</span>
  </span>
);

const config = {
  logo: <Logo />,
  project: { link: REPO },
  docsRepositoryBase: `${REPO}/tree/master/website`,
  // Brand color (Infima/Nextra primary hue).
  primaryHue: 212,
  primarySaturation: 90,
  darkMode: true,
  sidebar: {
    defaultMenuCollapseLevel: 1,
    toggleButton: true,
  },
  toc: {
    float: true,
    title: 'On this page',
    backToTop: true,
  },
  navigation: { prev: true, next: true },
  feedback: { content: null },
  editLink: { text: 'Edit this page on GitHub' },
  footer: {
    content: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.85rem' }}>
        <span>Apache-2.0 - Original, dependency-free code - &lt; 30 KB Brotli</span>
        <span style={{ opacity: 0.7 }}>OpenAlgo Charts - an open charting engine for the OpenAlgo community.</span>
      </div>
    ),
  },
  head: function Head() {
    const { frontMatter, title } = useConfig();
    const pageTitle = title && title !== 'OpenAlgo Charts' ? `${title} - OpenAlgo Charts` : 'OpenAlgo Charts';
    const description =
      (frontMatter as { description?: string }).description ??
      'A from-scratch, dependency-free HTML5-canvas charting engine for OpenAlgo: 25+ chart types, indicators, on-chart trading, and live data - under 30 KB.';
    return (
      <>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{pageTitle}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={description} />
        <meta name="theme-color" content="#0b0e16" />
      </>
    );
  },
};

export default config;
