import React from 'react';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  captureException: jest.fn(),
  setUser: jest.fn(),
  setScreen: jest.fn(),
  setContext: jest.fn(),
  getLogs: jest.fn(() => []),
  exportLogs: jest.fn(() => '[]'),
  flush: jest.fn(async () => {}),
  destroy: jest.fn(async () => {}),
};

export function useLogger() {
  return mockLogger;
}

export function LoggingProvider({ children }: { children: React.ReactNode }) {
  return children;
}

export { mockLogger as __mockLogger };
