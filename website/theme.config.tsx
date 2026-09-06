import React from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { useConfig } from 'nextra-theme-docs';

const REPO = 'https://github.com/marketcalls/openalgo-charts';

const Logo = () => (
  <span className="oac-brand">
    <span className="oac-brand__mark" aria-hidden="true"><i /></span>
    <span className="oac-brand__word">OpenAlgo<span>Charts</span></span>
  </span>
);

function NavigationExtra() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <div className="oac-nav-extra">
      <button type="button" className="oac-theme-toggle" aria-label="Toggle color theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
        <svg className="oac-theme-icon--sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" strokeLinecap="round" /></svg>
        <svg className="oac-theme-icon--moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8Z" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <Link href="/examples" className="oac-nav-cta">Explore charts ↗</Link>
    </div>
  );
}

const config = {
  logo: <Logo />,
  project: { link: REPO },
  docsRepositoryBase: `${REPO}/tree/master/website`,
  primaryHue: 218,
  primarySaturation: 85,
  darkMode: true,
  nextThemes: { defaultTheme: 'dark' },
  navbar: { extraContent: <NavigationExtra /> },
  search: { placeholder: 'Search docs...' },
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
      <div className="oac-site-footer">
        <div className="oac-site-footer__brand"><Link href="/" aria-label="OpenAlgo Charts home"><Logo /></Link><p>A clearer view of every move.<br />An open world of possibilities.</p></div>
        <div className="oac-site-footer__group"><h2>Explore</h2><Link href="/examples">Interactive examples</Link><Link href="/examples#drawing-tools">Drawing tools</Link><Link href="/examples#custom-indicators">Indicators</Link></div>
        <div className="oac-site-footer__group"><h2>Create</h2><Link href="/docs/getting-started">Get started</Link><Link href="/docs/core-concepts">Documentation</Link><a href="/openalgo-charts/api/index.html">API reference</a><a href={REPO} target="_blank" rel="noreferrer">Contribute on GitHub ↗</a></div>
        <div className="oac-site-footer__bottom"><span>OpenAlgo Charts · Built in the open.</span><a href={`${REPO}/blob/master/LICENSE`} target="_blank" rel="noreferrer">Free and open source · Apache-2.0</a></div>
      </div>
    ),
  },
  head: function Head() {
    const { frontMatter, title } = useConfig();
    const pageTitle = title && title !== 'OpenAlgo Charts' ? `${title} - OpenAlgo Charts` : 'OpenAlgo Charts — Every move. A clearer view.';
    const description =
      (frontMatter as { description?: string }).description ??
      'Explore beautiful interactive charts, powerful indicators, and expressive drawing tools with OpenAlgo Charts.';
    return (
      <>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{pageTitle}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={description} />
        <meta name="theme-color" content="#080a0e" />
      </>
    );
  },
};

export default config;
