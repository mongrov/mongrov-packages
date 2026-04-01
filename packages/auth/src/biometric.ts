import { useState, useEffect, useCallback } from 'react';

type LocalAuthModule = {
  hasHardwareAsync(): Promise<boolean>;
  isEnrolledAsync(): Promise<boolean>;
  authenticateAsync(options?: { promptMessage?: string }): Promise<{ success: boolean; error?: string }>;
};

let localAuthModule: LocalAuthModule | null | undefined; // undefined = not yet checked

function getLocalAuth(): LocalAuthModule | null {
  if (localAuthModule !== undefined) return localAuthModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    localAuthModule = require('expo-local-authentication') as LocalAuthModule;
  } catch {
    localAuthModule = null;
  }
  return localAuthModule;
}

export function useBiometricGate(): {
  isAvailable: boolean;
  isAuthenticated: boolean;
  authenticate: (reason?: string) => Promise<boolean>;
  error: string | null;
} {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mod = getLocalAuth();
    if (!mod) {
      setIsAvailable(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const hasHardware = await mod.hasHardwareAsync();
        const isEnrolled = await mod.isEnrolledAsync();
        if (!cancelled) {
          setIsAvailable(hasHardware && isEnrolled);
        }
      } catch {
        if (!cancelled) {
          setIsAvailable(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const authenticate = useCallback(async (reason?: string): Promise<boolean> => {
    const mod = getLocalAuth();
    if (!mod) {
      // Module unavailable — treat as success (don't block user)
      setIsAuthenticated(true);
      return true;
    }

    setError(null);
    try {
      const result = await mod.authenticateAsync({
        promptMessage: reason ?? 'Authenticate to continue',
      });
      setIsAuthenticated(result.success);
      if (!result.success && result.error) {
        setError(result.error);
      }
      return result.success;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Biometric authentication failed';
      setError(msg);
      setIsAuthenticated(false);
      return false;
    }
  }, []);

  return { isAvailable, isAuthenticated, authenticate, error };
}

/** @internal Reset module-level cache (for testing) */
export function __resetBiometricModule(): void {
  localAuthModule = undefined;
}
