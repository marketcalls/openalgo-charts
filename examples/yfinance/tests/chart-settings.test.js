import { describe, expect, it, vi } from 'vitest';
import { chartDecorationsForRebuild } from '../src/chart-settings.js';

describe('chart rebuild settings', () => {
  it('carries disabled branding and customized watermark options to the replacement chart', () => {
    const watermark = {
      visible: true,
      text: 'Desk view',
      color: '#aabbcc',
      opacity: 0.42,
      fontSize: 37,
    };
    const chart = {
      brandingOptions: vi.fn(() => false),
      watermarkOptions: vi.fn(() => ({ ...watermark })),
    };

    expect(chartDecorationsForRebuild(chart)).toEqual({ branding: false, watermark });
    expect(chart.brandingOptions).toHaveBeenCalledOnce();
    expect(chart.watermarkOptions).toHaveBeenCalledOnce();
  });

  it('carries custom branding and omits APIs an older build does not expose', () => {
    const branding = { href: 'https://charts.example.test', label: 'Charts provider' };
    expect(chartDecorationsForRebuild({ brandingOptions: () => ({ ...branding }) }))
      .toEqual({ branding });
    expect(chartDecorationsForRebuild(null)).toEqual({});
    expect(chartDecorationsForRebuild({})).toEqual({});
  });
});
