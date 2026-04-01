export const AuthenticationType = {
  FINGERPRINT: 1,
  FACIAL_RECOGNITION: 2,
  IRIS: 3,
} as const;

let mockAvailable = true;
let mockEnrolled = true;
let mockAuthResult = true;

export async function hasHardwareAsync(): Promise<boolean> {
  return mockAvailable;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return mockEnrolled;
}

export async function authenticateAsync(options?: {
  promptMessage?: string;
}): Promise<{ success: boolean; error?: string }> {
  return { success: mockAuthResult };
}

// Test helpers
export function __setAvailable(val: boolean): void {
  mockAvailable = val;
}
export function __setEnrolled(val: boolean): void {
  mockEnrolled = val;
}
export function __setAuthResult(val: boolean): void {
  mockAuthResult = val;
}
export function __reset(): void {
  mockAvailable = true;
  mockEnrolled = true;
  mockAuthResult = true;
}
