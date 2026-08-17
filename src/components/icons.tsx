/**
 * The house icon set — hand-authored inline SVG, no icon package.
 *
 * Every glyph is drawn on the same 24-unit grid with the same 1.75 stroke and
 * round caps so they read as one family, and every one paints with
 * `currentColor` so a single text-colour utility themes it. Icons are always
 * decorative here: the label next to them carries the meaning, and icon-only
 * buttons get an aria-label from their caller.
 */

export interface IconProps {
  className?: string;
}

function Glyph({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'h-5 w-5'}
    >
      {children}
    </svg>
  );
}

/* ---- Navigation ---- */

export function DashboardIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="7.5" height="8.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="5" rx="2" />
      <rect x="3" y="14.5" width="7.5" height="6.5" rx="2" />
      <rect x="13.5" y="11" width="7.5" height="10" rx="2" />
    </Glyph>
  );
}

export function TransactionsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 8h13" />
      <path d="m14 5 3 3-3 3" />
      <path d="M20 16H7" />
      <path d="m10 13-3 3 3 3" />
    </Glyph>
  );
}

export function ReviewIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 13.5h4l1.5 2.5h6l1.5-2.5h4" />
      <path d="M4.8 5.2 3.5 13.5v3.8A2.7 2.7 0 0 0 6.2 20h11.6a2.7 2.7 0 0 0 2.7-2.7v-3.8L19.2 5.2A2 2 0 0 0 17.3 4H6.7a2 2 0 0 0-1.9 1.2Z" />
    </Glyph>
  );
}

export function ImportIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3v10" />
      <path d="m8 9.5 4 4 4-4" />
      <path d="M4 16v2.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V16" />
    </Glyph>
  );
}

export function BudgetsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.6 17a9 9 0 1 1 16.8 0" />
      <path d="m12 13 4-3.5" />
      <circle cx="12" cy="17" r="1.4" />
    </Glyph>
  );
}

export function GoalsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
    </Glyph>
  );
}

export function WarrantiesIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.2 5 6v6c0 4.2 2.9 7.5 7 8.8 4.1-1.3 7-4.6 7-8.8V6l-7-2.8Z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </Glyph>
  );
}

export function ReportsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 20h16" />
      <path d="M7 20v-6" />
      <path d="M12 20V6" />
      <path d="M17 20v-9" />
    </Glyph>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </Glyph>
  );
}

/* ---- Chrome ---- */

export function SunIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4" />
    </Glyph>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z" />
    </Glyph>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </Glyph>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Glyph>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Glyph>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 5.5V4.2A1.2 1.2 0 0 0 12.8 3H5.2A1.2 1.2 0 0 0 4 4.2v15.6A1.2 1.2 0 0 0 5.2 21h7.6a1.2 1.2 0 0 0 1.2-1.2v-1.3" />
      <path d="M9.5 12H21" />
      <path d="m17.5 8.5 3.5 3.5-3.5 3.5" />
    </Glyph>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.8v4.8" />
      <circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Glyph>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 16.4v-4.8" />
      <circle cx="12" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 12h15" />
      <path d="m14 6.5 5.5 5.5L14 17.5" />
    </Glyph>
  );
}

/**
 * The mark: three rising bars inside a rounded tile — a ledger turning into a
 * trend, which is the whole product in one glyph. Filled (not stroked) so it
 * holds up at 24px next to the wordmark.
 */
export function LogoMark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className ?? 'h-8 w-8'}>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <g fill="var(--accent-fg)">
        <rect x="8" y="18" width="4" height="7" rx="2" />
        <rect x="14" y="13" width="4" height="12" rx="2" />
        <rect x="20" y="7" width="4" height="18" rx="2" />
      </g>
    </svg>
  );
}
