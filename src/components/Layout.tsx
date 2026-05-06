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
  Settings as Cog,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useState } from 'react';
import ConnectivityBanner from './ConnectivityBanner';
import LanguageSwitcher from './LanguageSwitcher';
import { useAuthStore } from '@/stores/authStore';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
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
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-brand grid place-items-center">
            <span className="text-white font-bold">A</span>
          </div>
          <span className="font-semibold">{t('app.name')}</span>
        </div>
        <LanguageSwitcher compact />
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside
          className={`fixed md:relative md:translate-x-0 z-40 inset-y-0 start-0 w-64 bg-surface border-e border-slate-700 transform transition-transform ${
            open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
          }`}
        >
          <div className="hidden md:flex h-16 px-5 items-center border-b border-slate-700 gap-3">
            <div className="w-9 h-9 rounded-lg bg-brand grid place-items-center shadow-lg shadow-brand/30">
              <span className="text-white font-bold text-lg">A</span>
            </div>
            <div>
              <div className="font-semibold text-base leading-tight">{t('app.name')}</div>
              <div className="text-xs text-slate-400 leading-tight">{t('app.tagline')}</div>
            </div>
          </div>

          <nav className="px-3 py-3 space-y-1 overflow-y-auto h-[calc(100vh-4rem)]">
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-brand text-white shadow shadow-brand/20'
                      : 'text-slate-300 hover:bg-surface-light hover:text-white'
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
              <div className="px-3 py-1 hidden md:block">
                <LanguageSwitcher />
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
