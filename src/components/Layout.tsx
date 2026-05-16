import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Users,
  UserCircle,
  PackageCheck,
  Sparkles,
  BookOpen,
  Smile,
  Map as MapIcon,
  MessageSquare,
  Smartphone,
  Settings as Cog,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useState } from 'react';
import ConnectivityBanner from './ConnectivityBanner';
import LanguageSwitcher from './LanguageSwitcher';
import ThemeToggle from './ThemeToggle';
import { useAuthStore } from '@/stores/authStore';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<any>;
}

export default function Layout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);

  const items: NavItem[] = [
    { to: '/assistant', label: t('nav.assistant'), icon: Sparkles },
    { to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
    { to: '/families', label: t('nav.families'), icon: Users },
    { to: '/distribute', label: t('nav.distribute'), icon: PackageCheck },
    { to: '/workers', label: t('nav.workers'), icon: UserCircle },
    { to: '/docs', label: t('nav.knowledge'), icon: BookOpen },
    { to: '/kids', label: t('nav.kids'), icon: Smile },
    { to: '/map', label: t('nav.map'), icon: MapIcon },
    { to: '/chat', label: t('nav.chat'), icon: MessageSquare },
    { to: '/aidflow-android', label: t('nav.aidflow_android'), icon: Smartphone },
    { to: '/settings', label: t('nav.settings'), icon: Cog },
  ];

  const handleSignOut = () => {
    signOut();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface-deep text-slate-100">
      <ConnectivityBanner />

      {/* Top bar (mobile) */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-surface">
        <button
          aria-label="Open menu"
          className="touch-target"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
        <div className="flex items-center">
          {/* Logo only — the wordmark is inside the image. The fallback
              letter tile + "AidFlow Pro" text only show if the file is
              missing (degenerate case). */}
          <img
            src="/logo.png"
            alt="AidFlow Pro"
            className="h-11 w-auto object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
              (e.currentTarget.nextSibling as HTMLElement | null)?.style?.setProperty('display', 'inline-flex');
            }}
          />
          <span
            className="hidden items-center gap-2"
            style={{ display: 'none' }}
          >
            <span className="w-7 h-7 rounded bg-brand grid place-items-center">
              <span className="text-white font-bold">A</span>
            </span>
            <span className="font-semibold">{t('app.name')}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LanguageSwitcher compact />
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed md:relative md:translate-x-0 z-40 inset-y-0 start-0 w-64 bg-surface border-e border-slate-700 transform transition-transform ${
            open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          <div className="hidden md:flex h-28 px-2 items-center justify-center border-b border-slate-700">
            {/* Logo only — the artwork already contains the "AIDFLOW"
                wordmark, so a sibling text block would be redundant.
                Header is sized to give the logo real presence (h-28 =
                112 px tall, logo h-24 = 96 px). The fallback letter
                tile (shown when /logo.png is missing) keeps the
                "AidFlow Pro" label since it has no wordmark of its own. */}
            <img
              src="/logo.png"
              alt="AidFlow Pro"
              className="h-24 w-auto object-contain"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
                (e.currentTarget.nextSibling as HTMLElement | null)?.style?.setProperty('display', 'inline-flex');
              }}
            />
            <span
              className="hidden items-center gap-2"
              style={{ display: 'none' }}
            >
              <span className="w-10 h-10 rounded-lg bg-brand grid place-items-center shadow-lg shadow-brand/30">
                <span className="text-white font-bold text-lg">A</span>
              </span>
              <span className="font-semibold text-base">{t('app.name')}</span>
            </span>
          </div>

          <nav className="px-3 py-3 space-y-1 overflow-y-auto h-[calc(100vh-7rem)]">
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-brand text-white shadow shadow-brand/20'
                      // Brand-tinted hover so the lift is visible in BOTH
                      // light and dark mode (text-slate-100 resolves to navy
                      // in light, near-white in dark — always readable on
                      // a faint teal wash).
                      : 'text-slate-300 hover:bg-brand/10 hover:text-slate-100'
                  }`
                }
              >
                <it.icon size={18} />
                <span className="flex-1">{it.label}</span>
              </NavLink>
            ))}

            <div className="pt-3 mt-3 border-t border-slate-700">
              {user && (
                <div className="px-3 py-2 text-xs text-slate-400">
                  <div className="font-medium text-slate-200">{user.name}</div>
                  <div className="capitalize">{user.role.replace('_', ' ')}</div>
                </div>
              )}
              <div className="px-3 py-1 hidden md:flex items-center gap-2">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
              <button
                onClick={handleSignOut}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:bg-red-500/10 hover:text-red-300 transition-colors"
              >
                <LogOut size={18} />
                <span>{t('nav.logout')}</span>
              </button>
            </div>
          </nav>
        </aside>

        {/* Backdrop for mobile sidebar */}
        {open && (
          <div
            className="fixed inset-0 bg-black/50 z-30 md:hidden"
            onClick={() => setOpen(false)}
          />
        )}

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-7xl mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
