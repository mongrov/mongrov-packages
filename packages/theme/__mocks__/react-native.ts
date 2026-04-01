export const Appearance = {
  getColorScheme: jest.fn(() => 'light' as 'light' | 'dark' | null),
  addChangeListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
};
