import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios'
import type { AuthClient, AuthLogger } from './types'
import { useEffect } from 'react'
import { useAuthClient } from './auth-provider'
import { describeError, noopLogger } from './log'

export interface AuthInterceptorOptions {
  /** Receives 401-retry failures. Default: no-op. */
  logger?: AuthLogger
}

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean
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
  options: AuthInterceptorOptions = {},
): () => void {
  const log = options.logger ?? noopLogger
  const requestId = axiosInstance.interceptors.request.use((config) => {
    const token = authClient.getAccessToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  })

  const responseId = axiosInstance.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as RetryableConfig | undefined

      if (!originalRequest || error.response?.status !== 401 || originalRequest._retry) {
        return Promise.reject(error)
      }

      originalRequest._retry = true

      try {
        const tokens = await authClient.refreshToken()
        originalRequest.headers.Authorization = `Bearer ${tokens.accessToken}`
        return axiosInstance(originalRequest)
      }
      catch (refreshErr) {
        // The refresh failure itself is logged by the auth client; this line
        // ties it to the request that triggered it.
        log.warn('[auth] 401 retry: refresh failed, signing out', {
          status: 401,
          error: describeError(refreshErr),
        })
        try {
          await authClient.signOut()
        }
        catch (signOutErr) {
          log.error('[auth] sign-out after failed refresh failed', { error: describeError(signOutErr) })
        }
        return Promise.reject(error)
      }
    },
  )

  return () => {
    axiosInstance.interceptors.request.eject(requestId)
    axiosInstance.interceptors.response.eject(responseId)
  }
}

/**
 * React hook that wires auth interceptors onto an Axios instance.
 * Automatically ejects on unmount.
 *
 * Must be used inside `<AuthProvider>`.
 *
 * ```tsx
 * import { useAuthInterceptor } from '@mongrov/auth/interceptor';
 * useAuthInterceptor(axiosClient);
 * ```
 */
export function useAuthInterceptor(axiosInstance: AxiosInstance, options: AuthInterceptorOptions = {}): void {
  const authClient = useAuthClient()
  const { logger } = options
  useEffect(() => {
    return createAuthInterceptor(axiosInstance, authClient, { logger })
  }, [axiosInstance, authClient, logger])
}
