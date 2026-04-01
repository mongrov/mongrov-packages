let mockDecoded: Record<string, unknown> = {
  sub: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  roles: ['user'],
  exp: Math.floor(Date.now() / 1000) + 3600,
};

export function jwtDecode(_token: string): Record<string, unknown> {
  return { ...mockDecoded };
}

// Test helpers
export function __setDecoded(val: Record<string, unknown>): void {
  mockDecoded = val;
}

export function __reset(): void {
  mockDecoded = {
    sub: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    roles: ['user'],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}
