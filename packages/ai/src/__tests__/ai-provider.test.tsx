import React from 'react';
import { renderHook } from '@testing-library/react';
import { AIProvider, useAIClient, useAIConfig, useAIContext } from '../ai-provider';
import type { AIConfig } from '../types';

// Mock model for testing
const mockModel = {
  specificationVersion: 'v1',
  provider: 'test',
  modelId: 'test-model',
  defaultObjectGenerationMode: 'json',
  doGenerate: jest.fn(),
  doStream: jest.fn(),
} as any;

const mockConfig: AIConfig = {
  model: mockModel,
  systemPrompt: 'You are a helpful assistant',
};

describe('AIProvider', () => {
  it('provides context to children', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AIProvider config={mockConfig}>{children}</AIProvider>
    );

    const { result } = renderHook(() => useAIContext(), { wrapper });
    expect(result.current.client).toBeDefined();
    expect(result.current.config).toBe(mockConfig);
  });

  it('throws when used outside provider', () => {
    // Suppress console.error for this test since React logs the error
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useAIContext());
    }).toThrow('useAIContext must be used within an AIProvider');

    consoleSpy.mockRestore();
  });
});

describe('useAIClient', () => {
  it('returns AI client', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AIProvider config={mockConfig}>{children}</AIProvider>
    );

    const { result } = renderHook(() => useAIClient(), { wrapper });
    expect(result.current).toBeDefined();
    expect(typeof result.current.chat).toBe('function');
    expect(typeof result.current.complete).toBe('function');
    expect(typeof result.current.cancel).toBe('function');
  });
});

describe('useAIConfig', () => {
  it('returns AI config', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AIProvider config={mockConfig}>{children}</AIProvider>
    );

    const { result } = renderHook(() => useAIConfig(), { wrapper });
    expect(result.current).toBe(mockConfig);
    expect(result.current.systemPrompt).toBe('You are a helpful assistant');
  });
});
