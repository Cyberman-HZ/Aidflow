import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Lock, AlertCircle } from 'lucide-react';
import { db } from '@/db/database';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import type { User } from '@/types';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  const [users, setUsers] = useState<User[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void db.users.toArray().then((rows) => {
      setUsers(rows);
      if (rows[0]) setSelectedId(rows[0].user_id);
    });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const u = users.find((x) => x.user_id === selectedId);
    if (!u) return;
    if (u.pin !== pin.trim()) {
      setError(t('login.wrong_pin'));
      return;
    }
    setUser(u);
    setLanguage(u.language);
    navigate('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-deep p-4">
      <div className="absolute top-4 end-4">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt="AidFlow Pro"
            className="mx-auto mb-4 h-20 w-auto object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
              (e.currentTarget.nextSibling as HTMLElement | null)?.style?.setProperty('display', 'inline-flex');
            }}
          />
          <div
            className="inline-flex w-16 h-16 rounded-2xl bg-brand items-center justify-center mb-4 shadow-2xl shadow-brand/30"
            style={{ display: 'none' }}
          >
            <ShieldCheck className="text-white" size={32} />
          </div>
          <h1 className="text-3xl font-bold">{t('app.name')}</h1>
          <p className="text-sm text-slate-400 mt-1">{t('app.tagline')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface rounded-2xl border border-slate-700 p-6 space-y-4"
        >
          <h2 className="text-lg font-semibold">{t('login.title')}</h2>
          <p className="text-sm text-slate-400 -mt-2">{t('login.subtitle')}</p>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5 font-medium">
              {t('login.select_user')}
            </label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full bg-surface-deep border border-slate-600 rounded-lg px-3 py-2.5 text-sm focus:border-brand outline-none"
            >
              {users.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.name} ({u.role.replace('_', ' ')})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1.5 font-medium">
              {t('login.pin')}
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500"
              />
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="••••"
                className="w-full bg-surface-deep border border-slate-600 rounded-lg ps-10 pe-3 py-2.5 text-base focus:border-brand outline-none touch-target"
                autoFocus
                required
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-brand hover:bg-brand-dark active:bg-brand-dark text-white font-semibold py-3 rounded-lg transition-colors touch-target"
          >
            {t('login.submit')}
          </button>

          <div className="pt-3 border-t border-slate-700 text-xs text-slate-400">
            <div className="font-medium mb-1.5">{t('login.demo_users')}:</div>
            <ul className="space-y-0.5">
              {users.map((u) => (
                <li key={u.user_id} className="flex justify-between">
                  <span>
                    {u.name} <span className="opacity-60">({u.role})</span>
                  </span>
                  <code className="bg-surface-deep px-1.5 rounded">{u.pin}</code>
                </li>
              ))}
            </ul>
          </div>
        </form>

        {/* Required attribution per the Gemma model variant naming &
            attribution guidelines. Tiny but always-visible: the login
            screen is the first thing users see. */}
        <p className="text-center text-[10px] text-slate-500 mt-6 leading-snug">
          {t('login.gemma_trademark') ?? 'Gemma is a trademark of Google LLC.'}{' '}
          {t('login.about_disclaimer') ??
            'AidFlow Pro is not affiliated with or endorsed by Google.'}
        </p>
      </div>
    </div>
  );
}
