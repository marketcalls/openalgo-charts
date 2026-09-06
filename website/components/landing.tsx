import React, { useEffect, useRef } from 'react';
import Link from 'next/link';
import BtcUsdChart from './BtcUsdChart';

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={diagonal ? 'M6 18 18 6M6 6h12v12' : 'M4 12h15m-6-6 6 6-6 6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.dataset.reveal = 'waiting';
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        el.dataset.reveal = 'visible';
        observer.disconnect();
      }
    }, { threshold: 0.08 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className={`oac-reveal ${className}`}>{children}</div>;
}

export function Hero() {
  return (
    <section className="oac-hero" aria-labelledby="hero-title">
      <div className="oac-hero__atmosphere" aria-hidden="true">
        <div className="oac-hero__halo" />
        <svg className="oac-hero__trace" viewBox="0 0 1440 680" preserveAspectRatio="none">
          <path d="M-40 610 110 560 215 578 340 463 430 491 555 370 650 396 810 238 900 284 1090 99 1190 130 1470 -15" />
          <path d="M-40 650 130 595 240 612 350 510 475 528 590 430 710 448 870 316 990 358 1120 225 1260 230 1470 84" />
        </svg>
      </div>
      <div className="oac-hero__copy">
        <div className="oac-eyebrow oac-intro oac-intro--eyebrow"><span className="oac-status-dot" /> THE OPENALGO CHARTING EXPERIENCE</div>
        <h1 id="hero-title" className="oac-hero__title">
          <span className="oac-title-line"><span className="oac-intro oac-intro--title">Every move.</span></span>
          <span className="oac-title-line"><span className="oac-intro oac-intro--gradient oac-gradient-text">A clearer view.</span></span>
        </h1>
        <p className="oac-hero__sub oac-intro oac-intro--sub">
          Go from watching the market to exploring it.<br className="oac-desktop-break" /> Beautiful charts. Powerful tools. A perspective that&rsquo;s yours.
        </p>
        <div className="oac-actions oac-intro oac-intro--actions">
          <a className="oac-action oac-action--primary" href="#playground">Try the live chart <Arrow /></a>
          <a className="oac-action oac-action--secondary" href="#possibilities">Explore the possibilities <Arrow diagonal /></a>
        </div>
        <p className="oac-hero__note oac-intro oac-intro--actions">Free to explore. Open source by nature.</p>
      </div>
      <BtcUsdChart />
      <div className="oac-capability-strip" aria-label="Chart capabilities">
        <span>More ways to see the market</span>
        <div><strong>15</strong> chart styles</div>
        <div><strong>102</strong> indicators</div>
        <div><strong>51</strong> drawing tools</div>
      </div>
    </section>
  );
}

function FeatureArt({ type }: { type: 'indicators' | 'drawings' | 'views' }) {
  if (type === 'indicators') return (
    <div className="oac-feature-art oac-feature-art--indicators" aria-hidden="true">
      <span className="oac-art-label">A little more insight.</span>
      <svg viewBox="0 0 360 175" fill="none">
        <path className="oac-art-grid" d="M0 35H360M0 80H360M0 125H360M50 0V175M130 0V175M210 0V175M290 0V175" />
        <path className="oac-art-band" d="M0 138Q38 113 70 124T137 97T205 95T270 59T360 35L360 84Q310 104 270 106T205 136T137 139T70 164T0 170Z" />
        <path className="oac-art-average" d="M0 154Q38 130 70 144T137 118T205 114T270 82T360 61" />
        <path className="oac-art-signal" d="M0 152 17 144 29 149 42 126 58 139 72 131 88 148 100 124 114 129 126 110 141 119 153 98 164 106 177 100 190 120 204 103 218 111 230 87 244 96 259 67 273 84 288 60 300 69 311 46 325 56 341 41 360 47" />
        <circle cx="311" cy="46" r="5" fill="var(--oac-accent-2)" /><circle cx="311" cy="46" r="12" stroke="var(--oac-accent-2)" opacity=".25" />
      </svg>
      <span className="oac-art-tag"><i /> Trend, momentum &amp; beyond</span>
    </div>
  );
  if (type === 'drawings') return (
    <div className="oac-feature-art oac-feature-art--drawings" aria-hidden="true">
      <span className="oac-art-label">Room for your next idea.</span>
      <svg viewBox="0 0 360 175" fill="none">
        <path className="oac-art-grid" d="M0 35H360M0 80H360M0 125H360M50 0V175M130 0V175M210 0V175M290 0V175" />
        <path d="M45 155 300 45 300 93 45 203Z" fill="var(--oac-accent)" opacity=".07" />
        <path d="M24 127 42 120 54 136 73 116 90 120 108 104 127 115 140 94 161 101 178 83 193 96 212 79 234 82 250 63 271 70 289 49 310 57 336 33" stroke="var(--oac-muted)" strokeWidth="1.7" opacity=".7" />
        <path d="M46 155 300 45M46 185 300 75" stroke="var(--oac-accent)" strokeWidth="1.5" />
        <path d="M210 0V175M0 82H360" stroke="var(--oac-accent)" strokeDasharray="3 5" opacity=".3" />
        <circle cx="46" cy="155" r="4" fill="var(--oac-card)" stroke="var(--oac-accent)" strokeWidth="2" />
        <circle cx="300" cy="45" r="4" fill="var(--oac-card)" stroke="var(--oac-accent)" strokeWidth="2" />
        <path d="m213 85 3 23 5-8 9-3Z" fill="var(--oac-text)" stroke="var(--oac-card)" strokeWidth="2" />
      </svg>
      <span className="oac-art-tag">Trend lines · Channels · Fibonacci</span>
    </div>
  );
  return (
    <div className="oac-feature-art oac-feature-art--views" aria-hidden="true">
      <span className="oac-art-label">A different angle changes everything.</span>
      <div className="oac-art-views">
        <div className="oac-art-view oac-art-view--candles"><span>Candles</span><svg viewBox="0 0 110 96" fill="none"><path d="M15 43V86M36 35V73M57 40V78M78 15V57M99 3V43" stroke="var(--oac-accent-2)" /><path d="M15 52V76M36 42V65M57 49V68M78 24V46M99 13V33" stroke="var(--oac-accent-2)" strokeWidth="7" /></svg></div>
        <div className="oac-art-view oac-art-view--line"><span>Line</span><svg viewBox="0 0 110 96" fill="none"><path d="M0 80 15 70 25 74 39 49 49 59 62 33 75 41 86 19 97 25 110 7" stroke="var(--oac-accent)" strokeWidth="2" /></svg></div>
        <div className="oac-art-view oac-art-view--area"><span>Area</span><svg viewBox="0 0 110 96" fill="none"><path d="M0 80 15 70 25 74 39 49 49 59 62 33 75 41 86 19 97 25 110 7V96H0Z" fill="var(--oac-accent)" opacity=".15" /><path d="M0 80 15 70 25 74 39 49 49 59 62 33 75 41 86 19 97 25 110 7" stroke="var(--oac-accent)" strokeWidth="2" /></svg></div>
      </div>
      <span className="oac-art-tag">Find a view that speaks to you</span>
    </div>
  );
}

export function Features() {
  return (
    <section id="possibilities" className="oac-section oac-possibilities" aria-labelledby="possibilities-title">
      <Reveal className="oac-section-heading">
        <span className="oac-eyebrow">BUILT FOR YOUR CURIOSITY</span>
        <h2 id="possibilities-title">There&rsquo;s more to<br /><span className="oac-text-muted">every market move.</span></h2>
        <p>Follow the trend. Connect the dots. See what you couldn&rsquo;t see before.</p>
      </Reveal>
      <div className="oac-features">
        <Reveal className="oac-feature">
          <FeatureArt type="indicators" />
          <div className="oac-feature__copy"><span className="oac-feature__index">01 / DISCOVER</span><h3>Look beneath the surface.</h3><p>Bring price, momentum, and volatility into focus with 102 indicators. Layer your favorites and explore the bigger picture.</p><Link href="/examples#custom-indicators" className="oac-text-link">Explore indicators <Arrow /></Link></div>
        </Reveal>
        <Reveal className="oac-feature">
          <FeatureArt type="drawings" />
          <div className="oac-feature__copy"><span className="oac-feature__index">02 / EXPRESS</span><h3>Give your ideas a shape.</h3><p>Mark a level. Map a scenario. Tell the story you see with 51 drawing tools that put your thinking right on the chart.</p><Link href="/examples#drawing-tools" className="oac-text-link">Try the drawing tools <Arrow /></Link></div>
        </Reveal>
        <Reveal className="oac-feature">
          <FeatureArt type="views" />
          <div className="oac-feature__copy"><span className="oac-feature__index">03 / MAKE IT YOURS</span><h3>A fresh perspective, instantly.</h3><p>From the detail of candlesticks to the simplicity of a line. Find your rhythm with 15 chart styles and a look that feels like you.</p><Link href="/examples#interactive" className="oac-text-link">Find your view <Arrow /></Link></div>
        </Reveal>
      </div>
    </section>
  );
}

export function WhyOpenSource() {
  return (
    <>
      <section className="oac-section oac-freedom" aria-labelledby="freedom-title">
        <Reveal className="oac-freedom__copy">
          <span className="oac-eyebrow">YOUR CHARTS. YOUR RULES.</span>
          <h2 id="freedom-title">Made to be<br /><span className="oac-gradient-text">made your own.</span></h2>
          <p>Your style. Your workflow. Your next big idea. OpenAlgo Charts gives you the freedom to create a charting experience that feels entirely yours.</p>
          <Link href="/examples" className="oac-text-link">See what&rsquo;s possible <Arrow diagonal /></Link>
        </Reveal>
        <Reveal className="oac-freedom__details">
          <div><span className="oac-freedom__icon" aria-hidden="true">✦</span><div><h3>Every detail, considered.</h3><p>Thoughtful tools, fluid interaction, and room to focus on what matters to you.</p></div></div>
          <div><span className="oac-freedom__icon" aria-hidden="true">◐</span><div><h3>At home in your world.</h3><p>Light or dark. A single chart or a complete workspace. Shape it around the way you work.</p></div></div>
          <div><span className="oac-freedom__icon" aria-hidden="true">↗</span><div><h3>Open from the start.</h3><p>Free to use, explore, and extend. Built in the open, for a community that keeps moving.</p></div></div>
        </Reveal>
      </section>
      <section className="oac-section oac-closing" aria-labelledby="closing-title">
        <Reveal>
          <span className="oac-eyebrow">A CHART IS JUST THE BEGINNING</span>
          <h2 id="closing-title">What will you see next?</h2>
          <p>Your next perspective is a click away.</p>
          <div className="oac-actions"><a href="#playground" className="oac-action oac-action--primary">Make your first move <Arrow /></a><Link href="/docs/getting-started" className="oac-action oac-action--secondary">Start creating <Arrow diagonal /></Link></div>
          <span className="oac-closing__wordmark" aria-hidden="true">OpenAlgo</span>
        </Reveal>
      </section>
    </>
  );
}
