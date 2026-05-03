// Demo auth store. Per the PDF a real impl would use JWT + bcrypt, but we
// only need PIN-based login since there's no backend.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@/types';

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (u) => set({ user: u }),
      signOut: () => set({ user: null }),
    }),
    { name: 'aidflow-auth' }
  )
);
