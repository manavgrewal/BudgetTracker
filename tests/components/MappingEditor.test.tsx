// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MappingEditor } from '@/components/MappingEditor';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { DateFormatDetection } from '@/lib/import/detect-date-format';

afterEach(() => cleanup());

const BASE_MAPPING = getBuiltinPreset('TD Chequing/Debit'); // dateFormat: 'YYYY-MM-DD'

function detection(over: Partial<DateFormatDetection>): DateFormatDetection {
  return { candidates: [], status: 'none', detected: null, ...over };
}

describe('MappingEditor — date format detection surfaces where the format is chosen', () => {
  it('says nothing when detection was not passed at all', () => {
    render(<MappingEditor mapping={BASE_MAPPING} onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing when the confident detection already matches the selected format', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'unique', detected: 'YYYY-MM-DD', candidates: ['YYYY-MM-DD'] })}
      />,
    );
    expect(screen.queryByText(/Detected format/i)).toBeNull();
  });

  it('offers a one-click switch when a confident detection disagrees with the selected format, without changing it on its own', () => {
    const onChange = vi.fn();
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={onChange}
        dateFormatDetection={detection({ status: 'unique', detected: 'DD/MM/YYYY', candidates: ['DD/MM/YYYY'] })}
      />,
    );

    expect(screen.getByText(/Detected format: DD\/MM\/YYYY/i)).toBeTruthy();
    // Rendering the mismatch must not itself have called onChange — an explicitly
    // chosen format is left alone until the user acts.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /use dd\/mm\/yyyy/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...BASE_MAPPING, dateFormat: 'DD/MM/YYYY' });
  });

  it('treats a "resolved" (tied but agreeing) detection the same as "unique" for the mismatch hint', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'resolved', detected: 'YYYY/MM/DD', candidates: ['YYYY-MM-DD', 'YYYY/MM/DD'] })}
      />,
    );
    expect(screen.getByText(/Detected format: YYYY\/MM\/DD/i)).toBeTruthy();
  });

  it('surfaces an unmissable, unaccepted warning when detection is ambiguous — the silent day/month swap case', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'ambiguous', detected: null, candidates: ['MM/DD/YYYY', 'DD/MM/YYYY'] })}
      />,
    );

    // role="alert" (not the polite "status" role the other branches use) is what makes
    // this impossible to miss, including for a screen reader — this is the exact
    // scenario that corrupts dates silently if nobody notices.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/ambiguous/i);
    expect(alert.textContent).toMatch(/day and the month/i);
    expect(alert.textContent).toContain('MM/DD/YYYY');
    expect(alert.textContent).toContain('DD/MM/YYYY');
    // No auto-accept button is offered — detection refuses to guess, so there is
    // nothing here that could apply the wrong pick with a single click.
    expect(screen.queryByRole('button', { name: /use / })).toBeNull();
  });

  it('says so, rather than staying silent, when no known format matches at all', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'none', detected: null, candidates: [] })}
      />,
    );
    expect(screen.getByText(/Could not recognize this column's date format/i)).toBeTruthy();
  });
});
