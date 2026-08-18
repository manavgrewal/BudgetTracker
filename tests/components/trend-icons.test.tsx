// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TrendDownIcon, TrendFlatIcon, TrendUpIcon } from '@/components/icons';

afterEach(() => cleanup());

describe('MUST-14.9: the three trend glyphs', () => {
  it('renders decorative svgs that follow the house Glyph convention', () => {
    for (const Icon of [TrendUpIcon, TrendDownIcon, TrendFlatIcon]) {
      const { container } = render(<Icon className="h-4 w-4" />);
      const svg = container.querySelector('svg') as SVGElement;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('class')).toBe('h-4 w-4');
      cleanup();
    }
  });
});
