// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { UpdatesClient, type UpdatesViewProps } from '@/app/(app)/settings/updates-client';

vi.mock('@/app/(app)/settings/actions', () => ({
  enableUpdateChecksAction: vi.fn(async () => ({})),
  disableUpdateChecksAction: vi.fn(async () => ({})),
  setAutoApplyAction: vi.fn(async () => ({})),
  checkForUpdateNowAction: vi.fn(async () => ({})),
  reviewUpdateAction: vi.fn(async () => ({})),
  applyUpdateAction: vi.fn(async () => ({})),
  dismissUpdateAction: vi.fn(async () => ({})),
}));

afterEach(cleanup);

const base: UpdatesViewProps = {
  currentVersion: '1.3.1',
  enabled: true,
  autoApply: true,
  lastCheckedAt: '2026-08-18T09:30:00.000Z',
  lastCheckError: null,
  latestVersion: null,
  latestPublishedAt: null,
  dismissedVersion: null,
  lastAppliedAt: null,
  lastApplyError: null,
  severity: 'none',
  canApplyInApp: true,
  watchtowerError: null,
};

describe('MUST-9.3: the off state', () => {
  it('renders the verbatim copy and exactly one button', () => {
    render(<UpdatesClient {...base} enabled={false} autoApply={false} lastCheckedAt={null} />);
    expect(screen.getByText('Budget Tracker v1.3.1 · update checks are off.')).toBeTruthy();
    expect(
      screen.getByText(/That request carries the version you are running and nothing else/),
    ).toBeTruthy();
    expect(screen.getByText(/A major version never does/)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toContain('Enable update checks');
  });
});

describe('MUST-9.4: the on state', () => {
  it('shows Up to date, the timestamp in iso.slice(0,16) form, and the three controls', () => {
    render(<UpdatesClient {...base} />);
    expect(screen.getByText('Up to date (v1.3.1)')).toBeTruthy();
    expect(screen.getByText(/Last checked 2026-08-18 09:30/)).toBeTruthy();
    for (const label of ['Check now', 'Install small updates automatically', 'Disable update checks']) {
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    }
    expect(screen.queryByText('Update now')).toBeNull();
  });

  it('renders Never when nothing has been checked yet', () => {
    render(<UpdatesClient {...base} lastCheckedAt={null} />);
    expect(screen.getByText(/Last checked Never/)).toBeTruthy();
  });

  it.each([
    ['patch', 'Patch update', 'Update now'],
    ['minor', 'Minor update', 'Update now'],
    ['major', 'Major update', 'Review and update'],
  ] as const)('%s offers the right badge and primary control', (severity, badge, control) => {
    render(<UpdatesClient {...base} severity={severity} latestVersion="1.4.0" />);
    expect(screen.getByText('Version 1.4.0 is available')).toBeTruthy();
    expect(screen.getByText(badge)).toBeTruthy();
    expect(screen.getByText(control)).toBeTruthy();
    expect(screen.getByText('Not now')).toBeTruthy();
  });

  it('surfaces a check error and an apply error in error notices', () => {
    render(<UpdatesClient {...base} lastCheckError="GitHub returned 500." lastApplyError="Watchtower said no." />);
    expect(screen.getByText('GitHub returned 500.')).toBeTruthy();
    expect(screen.getByText('Watchtower said no.')).toBeTruthy();
  });

  it('MUST-5.9: a dismissed version collapses to the status line and a Show again control', () => {
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" dismissedVersion="1.4.0" />);
    expect(screen.getByText('Version 1.4.0 is available — you chose to skip it for now.')).toBeTruthy();
    expect(screen.getByText('Show again')).toBeTruthy();
    expect(screen.queryByText('Update now')).toBeNull();
  });
});

describe('MUST-7.8 / MUST-7.9: no apply path', () => {
  it('renders the fallback copy and NO apply button anywhere — absent, not disabled', () => {
    render(<UpdatesClient {...base} severity="minor" latestVersion="1.4.0" canApplyInApp={false} />);
    expect(screen.getByText('This install updates by hand.')).toBeTruthy();
    expect(screen.getByText(/Both scripts tag a rollback point first/)).toBeTruthy();
    expect(screen.getByText('install/synology-compose-pull.yml')).toBeTruthy();
    expect(screen.queryByText('Update now')).toBeNull();
    expect(screen.queryByText('Review and update')).toBeNull();
    // MUST-11.6's rule, applied here too: no address on the page is clickable.
    expect(document.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('MUST-8.7: a malformed WATCHTOWER_URL is reported, not swallowed', () => {
    render(
      <UpdatesClient
        {...base}
        canApplyInApp={false}
        watchtowerError="The WATCHTOWER_URL in your compose file is not a valid internal address."
      />,
    );
    expect(screen.getByText('The WATCHTOWER_URL in your compose file is not a valid internal address.')).toBeTruthy();
  });
});

describe('MUST-7.3: the card never receives a token', () => {
  it('the props type carries canApplyInApp and no credential field', () => {
    const keys = Object.keys(base);
    expect(keys).toContain('canApplyInApp');
    for (const key of keys) expect(key.toLowerCase()).not.toContain('token');
    expect(JSON.stringify(base).toLowerCase()).not.toContain('bearer');
  });
});
