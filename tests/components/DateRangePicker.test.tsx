// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DateRangePicker } from '@/components/ui/DateRangePicker';

afterEach(() => cleanup());

function renderInForm(props: Parameters<typeof DateRangePicker>[0]) {
  const { container } = render(
    <form data-testid="filter">
      <DateRangePicker {...props} />
    </form>,
  );
  return container.querySelector('form') as HTMLFormElement;
}

const base = { value: 'last_6_months' as const, from: '2026-03-01', to: '2026-08-31', today: '2026-08-18' };

describe('MUST-12.1 and D1: the options', () => {
  it('renders seven options without allowAny and eight with it', () => {
    renderInForm(base);
    expect(screen.getAllByRole('option')).toHaveLength(7);
    cleanup();
    renderInForm({ ...base, allowAny: true, value: '' });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(8);
    expect(options[0].getAttribute('value')).toBe('');
    expect(options[0].textContent).toBe('Any dates');
  });
});

describe('MUST-12.3 and MUST-12.4: the field names and the disabled inputs', () => {
  it('names the select "range" and the two inputs "from" and "to"', () => {
    const form = renderInForm(base);
    expect(form.querySelector('select[name="range"]')).not.toBeNull();
    expect(form.querySelector('input[name="from"]')).not.toBeNull();
    expect(form.querySelector('input[name="to"]')).not.toBeNull();
  });

  it('disables the two date inputs for any preset other than custom', () => {
    const form = renderInForm(base);
    expect((form.querySelector('input[name="from"]') as HTMLInputElement).disabled).toBe(true);
    expect((form.querySelector('input[name="to"]') as HTMLInputElement).disabled).toBe(true);
  });

  it('a disabled input is not in the submitted FormData, so a stale pair cannot ride along', () => {
    const form = renderInForm(base);
    const data = new FormData(form);
    expect(data.get('range')).toBe('last_6_months');
    expect(data.get('from')).toBeNull();
    expect(data.get('to')).toBeNull();
  });

  it('selecting custom reveals two enabled, prefilled inputs that do submit', () => {
    const form = renderInForm(base);
    fireEvent.change(form.querySelector('select[name="range"]') as HTMLSelectElement, { target: { value: 'custom' } });
    const from = form.querySelector('input[name="from"]') as HTMLInputElement;
    const to = form.querySelector('input[name="to"]') as HTMLInputElement;
    expect(from.disabled).toBe(false);
    expect(to.disabled).toBe(false);
    expect(from.value).toBe('2026-03-01');
    expect(to.value).toBe('2026-08-31');
    const data = new FormData(form);
    expect(data.get('range')).toBe('custom');
    expect(data.get('from')).toBe('2026-03-01');
    expect(data.get('to')).toBe('2026-08-31');
  });
});

describe('MUST-12.6: the custom inputs are bounded by the server-resolved today', () => {
  it('puts the today prop on both max attributes', () => {
    const form = renderInForm({ ...base, value: 'custom' });
    expect((form.querySelector('input[name="from"]') as HTMLInputElement).getAttribute('max')).toBe('2026-08-18');
    expect((form.querySelector('input[name="to"]') as HTMLInputElement).getAttribute('max')).toBe('2026-08-18');
  });
});

describe('MUST-12.2 and MUST-12.7: a form control, not a router', () => {
  it('labels the select and both inputs', () => {
    renderInForm({ ...base, value: 'custom' });
    expect(screen.getByText('Dates')).toBeTruthy();
    expect(screen.getByText('From')).toBeTruthy();
    expect(screen.getByText('To')).toBeTruthy();
  });
});
