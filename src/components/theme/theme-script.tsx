import { THEME_STORAGE_KEY } from './theme';

/**
 * Runs before first paint so the page never flashes the wrong theme.
 *
 * It has to be an inline <script> (an external file would arrive too late), and
 * this app serves a nonce-based CSP from src/middleware.ts — so the tag MUST
 * carry the per-request nonce or the browser refuses to run it and every visit
 * starts light. The root layout reads `x-nonce` off the request headers and
 * passes it down; tests/components/theme-script.test.tsx guards the wiring.
 *
 * Kept deliberately tiny and dependency-free: it is parsed and executed on the
 * critical path of every single page load.
 */
const SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=s==='dark'||(s!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export function ThemeScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
