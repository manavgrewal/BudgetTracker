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

  it('says nothing for a "resolved" detection whose candidates already include the selected format — that is just two formats agreeing with the user\'s own pick, not a mismatch', () => {
    // Reachable fixture: 'YYYY-MM-DD' and 'YYYY/MM/DD' parse identically in dates.ts, so an
    // ISO-shaped sample makes both survive and resolves to candidates[0] = 'YYYY-MM-DD'.
    // BASE_MAPPING's dateFormat is 'YYYY-MM-DD', which is itself one of the two candidates,
    // so there is nothing here to warn about.
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'resolved', detected: 'YYYY-MM-DD', candidates: ['YYYY-MM-DD', 'YYYY/MM/DD'] })}
      />,
    );
    expect(screen.queryByText(/Detected format/i)).toBeNull();
  });

  it('release review finding A: never offers a one-click switch for "resolved" when the selected format is not among the candidates — the agreement is coincidental, not proof', () => {
    // Reachable fixture for the real corruption case the finding describes: every sampled
    // date happened to have day == month, so MM/DD/YYYY and DD/MM/YYYY both parse the whole
    // sample AND agree with each other on it (see the matching detectDateFormat test), even
    // though nothing here proves which one is right for a row the sample didn't cover.
    // BASE_MAPPING's 'YYYY-MM-DD' is not one of the two candidates, so the mismatch is real
    // and worth surfacing — but only as information, never as a single click that could
    // silently swap day and month for the rest of the file.
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'resolved', detected: 'MM/DD/YYYY', candidates: ['MM/DD/YYYY', 'DD/MM/YYYY'] })}
      />,
    );
    expect(screen.getByText(/Detected format: MM\/DD\/YYYY/i)).toBeTruthy();
    expect(screen.getByText(/happen to agree with each other on this sample/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use / })).toBeNull();
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

  it('says so, rather than staying silent, when no known format matches at all — and release review finding B: names the likely cause instead of only sending the user to the column number', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'none', detected: null, candidates: [] })}
      />,
    );
    expect(screen.getByText(/Could not recognize this column's date format/i)).toBeTruthy();
    // 'none' is reachable by feeding a headerless preset's own header row (or an
    // opening-balance/footer line) into detection, which is usually a "Has header" miss,
    // not actually a wrong column number — say so before the generic advice. Scoped to the
    // notice itself (via .textContent, which unlike getByText's own-text-node matching does
    // include the nested <strong>): the form has its own "Header rows" field label and
    // "Has header" checkbox label elsewhere on the page that a loose getByText(/.../) would
    // also match.
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/a header row/i);
    expect(notice.textContent).toMatch(/Has header/);
  });

  it('release review finding C: disables the one-click switch button while the caller has a request in flight, so it cannot double-fire', () => {
    render(
      <MappingEditor
        mapping={BASE_MAPPING}
        onChange={vi.fn()}
        dateFormatDetection={detection({ status: 'unique', detected: 'DD/MM/YYYY', candidates: ['DD/MM/YYYY'] })}
        busy
      />,
    );
    expect((screen.getByRole('button', { name: /use dd\/mm\/yyyy/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
