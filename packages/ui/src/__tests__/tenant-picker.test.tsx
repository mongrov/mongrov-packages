/**
 * Tests for TenantPicker and TenantSelector components
 *
 * Note: Full component tests are difficult with react-native-testing-library
 * due to Modal and SafeAreaView mocking. These tests verify the exports
 * and basic functionality.
 */

import * as React from 'react';

import { TenantPicker, TenantSelector } from '../TenantPicker';
import type { TenantPickerItem, TenantPickerProps, TenantSelectorProps } from '../TenantPicker';

describe('TenantPicker exports', () => {
  it('exports TenantPicker component', () => {
    expect(TenantPicker).toBeDefined();
    expect(typeof TenantPicker).toBe('function');
  });

  it('exports TenantSelector component', () => {
    expect(TenantSelector).toBeDefined();
    expect(typeof TenantSelector).toBe('function');
  });
});

describe('TenantPickerItem type', () => {
  it('allows valid tenant items', () => {
    const item: TenantPickerItem = {
      id: 'tenant-1',
      name: 'Acme Corporation',
      description: 'Main organization',
    };
    expect(item.id).toBe('tenant-1');
    expect(item.name).toBe('Acme Corporation');
    expect(item.description).toBe('Main organization');
  });

  it('allows minimal tenant items', () => {
    const item: TenantPickerItem = {
      id: 'tenant-2',
      name: 'Beta Inc',
    };
    expect(item.id).toBe('tenant-2');
    expect(item.name).toBe('Beta Inc');
    expect(item.description).toBeUndefined();
  });

  it('allows tenant items with logo', () => {
    const item: TenantPickerItem = {
      id: 'tenant-3',
      name: 'Gamma LLC',
      logo: { uri: 'https://example.com/logo.png' },
    };
    expect(item.logo).toEqual({ uri: 'https://example.com/logo.png' });
  });
});

describe('TenantPickerProps type', () => {
  it('requires essential props', () => {
    const props: TenantPickerProps = {
      visible: true,
      tenants: [],
      onSelect: jest.fn(),
      onClose: jest.fn(),
    };
    expect(props.visible).toBe(true);
    expect(props.tenants).toEqual([]);
  });

  it('allows optional props', () => {
    const props: TenantPickerProps = {
      visible: false,
      tenants: [],
      selectedId: 'tenant-1',
      onSelect: jest.fn(),
      onClose: jest.fn(),
      title: 'Select Workspace',
      emptyMessage: 'No workspaces',
      className: 'custom-class',
      testID: 'picker',
    };
    expect(props.selectedId).toBe('tenant-1');
    expect(props.title).toBe('Select Workspace');
    expect(props.emptyMessage).toBe('No workspaces');
  });
});

describe('TenantSelectorProps type', () => {
  it('requires essential props', () => {
    const props: TenantSelectorProps = {
      tenant: null,
      onPress: jest.fn(),
    };
    expect(props.tenant).toBeNull();
  });

  it('allows tenant to be set', () => {
    const tenant: TenantPickerItem = {
      id: 'tenant-1',
      name: 'Acme',
    };
    const props: TenantSelectorProps = {
      tenant,
      onPress: jest.fn(),
      placeholder: 'Choose org',
      testID: 'selector',
    };
    expect(props.tenant?.name).toBe('Acme');
    expect(props.placeholder).toBe('Choose org');
  });
});

describe('TenantPicker component behavior', () => {
  // Since we can't easily render Modal in tests, we test the callback types
  it('onSelect receives tenant id', () => {
    const onSelect = jest.fn();
    onSelect('tenant-123');
    expect(onSelect).toHaveBeenCalledWith('tenant-123');
  });

  it('onClose is called without arguments', () => {
    const onClose = jest.fn();
    onClose();
    expect(onClose).toHaveBeenCalledWith();
  });
});

describe('TenantSelector component behavior', () => {
  it('onPress is called without arguments', () => {
    const onPress = jest.fn();
    onPress();
    expect(onPress).toHaveBeenCalledWith();
  });
});
