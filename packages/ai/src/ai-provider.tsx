import type { ReactNode } from 'react'
import type { AIClient, AIConfig } from './types'
import * as React from 'react'
import { createContext, useContext, useMemo } from 'react'
import { createAIClient } from './ai-client'

interface AIContextValue {
  client: AIClient
  config: AIConfig
}

const AIContext = createContext<AIContextValue | null>(null)

export interface AIProviderProps {
  config: AIConfig
  children: ReactNode
}

export function AIProvider({ config, children }: AIProviderProps) {
  const value = useMemo<AIContextValue>(() => {
    const client = createAIClient(config)
    return { client, config }
  }, [config])

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>
}

export function useAIContext(): AIContextValue {
  const context = useContext(AIContext)
  if (!context) {
    throw new Error('useAIContext must be used within an AIProvider')
  }
  return context
}

export function useAIClient(): AIClient {
  const { client } = useAIContext()
  return client
}

export function useAIConfig(): AIConfig {
  const { config } = useAIContext()
  return config
}
