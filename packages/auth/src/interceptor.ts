import type { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { AuthClient } from './types';

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

/**
 * Attaches Bearer token to requests and retries once on 401 after refreshing.
 *
 * Concurrent 401s are safe: `authClient.refreshToken()` is a single-flight
 * guard inside the refresh manager, so multiple interceptors will share the
 * same in-flight refresh promise rather than queuing separate refresh calls.
 *
 * @returns eject function that removes both interceptors
 */
export function createAuthInterceptor(
  axiosInstance: AxiosInstance,
  authClient: AuthClient,
): () => void {
  const requestId = axiosInstance.interceptors.request.use((config) => {
    const token = authClient.getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  const responseId = axiosInstance.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as RetryableConfig | undefined;

      if (!originalRequest || error.response?.status !== 401 || originalRequest._retry) {
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      try {
        const tokens = await authClient.refreshToken();
        originalRequest.headers.Authorization = `Bearer ${tokens.accessToken}`;
        return axiosInstance(originalRequest);
      } catch {
        await authClient.signOut();
        return Promise.reject(error);
      }
    },
  );

  return () => {
    axiosInstance.interceptors.request.eject(requestId);
    axiosInstance.interceptors.response.eject(responseId);
  };
}
