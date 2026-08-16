// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { WizardClient } from '@/app/(app)/import/wizard/wizard-client';
import { getBuiltinPreset } from '@/lib/import/presets';

vi.mock('@/app/(app)/import/actions', () => ({
  saveWizardProfileAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WizardClient — polish item 8: the sample upload is busy-guarded', () => {
  it('disables the upload button for as long as the request is in flight', async () => {
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = resolve;
          }),
      ),
    );

    const { container, getByRole } = render(<WizardClient starterMapping={getBuiltinPreset('TD Chequing/Debit')} />);
    const button = () => getByRole('button', { name: /show the first rows|working/i }) as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    fireEvent.submit(container.querySelector('form')!);
    // Double-submitting used to stage the same sample file twice and orphan the
    // second staging id. The guard is useFormStatus (via SubmitButton), because a
    // local busy flag set inside an async form action does not render until that
    // action settles.
    await waitFor(() => expect(button().disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});
