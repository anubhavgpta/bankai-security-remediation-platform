import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getSession, type PublicUser } from './api';

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  setUser: (user: PublicUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getSession()
      .then(({ user: sessionUser }) => {
        if (!cancelled) setUser(sessionUser);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return <AuthContext.Provider value={{ user, loading, setUser }}>{children}</AuthContext.Provider>;
}

export function useCurrentUser(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useCurrentUser must be used within an AuthProvider');
  return ctx;
}

export function getInitials(user: PublicUser | null): string {
  const source = user?.fullName?.trim() || user?.email?.trim() || '';
  if (!source) return '?';

  if (source.includes('@')) return source[0]!.toUpperCase();

  const parts = source.split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]!.toUpperCase());
  return initials.join('') || '?';
}

export function getDisplayName(user: PublicUser | null): string {
  return user?.fullName?.trim() || user?.email?.trim() || 'Account';
}

// Fixed palette (matches the accent colors already used for team members in
// Settings) rather than fully random RGB, so avatars stay legible with white
// text and on-brand. The same user always lands on the same color since it's
// hashed from their id, not re-rolled on every render.
const AVATAR_COLORS = ['#22C55E', '#2563EB', '#7C3AED', '#EA580C', '#DB2777', '#0D9488', '#CA8A04'];

export function getAvatarColor(user: PublicUser | null): string {
  const source = user?.id || user?.email || '';
  if (!source) return AVATAR_COLORS[0]!;

  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export function getAvatarStyle(user: PublicUser | null): { background: string; boxShadow: string } {
  const color = getAvatarColor(user);
  return { background: color, boxShadow: `0 0 0 2px var(--color-bg), 0 0 0 3.5px ${color}` };
}
