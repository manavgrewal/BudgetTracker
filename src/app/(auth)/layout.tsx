/**
 * The signed-out shell: no navigation to speak of, so the page gets to be a
 * single centred card floating on an ambient wash (two very low-opacity radial
 * tints keyed off the accent — see `.auth-wash` in globals.css). Nothing else
 * competes with the one thing there is to do here.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-wash flex min-h-screen flex-col items-center justify-center px-4 py-12">{children}</main>
  );
}
