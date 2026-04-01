import { useMemo } from 'react';
import type { Session } from './types';
import { useAuth, useAuthClient } from './auth-provider';

export function useSession(): Session | null {
  const { isAuthenticated, user } = useAuth();
  const client = useAuthClient();

  const permissions = useMemo(() => user?.roles ?? [], [user]);

  if (!isAuthenticated || !user) return null;

  // Read accessToken outside useMemo — it changes on silent refresh
  // without triggering a user/isAuthenticated change.
  const accessToken = client.getAccessToken();
  if (!accessToken) return null;

  return {
    user,
    permissions,
    hasPermission: (permission: string) => permissions.includes(permission),
    accessToken,
  };
}
