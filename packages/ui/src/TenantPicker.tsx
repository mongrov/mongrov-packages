/**
 * TenantPicker Component
 *
 * A modal picker for selecting tenants in multi-tenant applications.
 * Displays a list of available tenants with logos and names.
 *
 * @example
 * ```tsx
 * const { tenants, tenant, setTenant } = useTenantContext();
 *
 * <TenantPicker
 *   visible={showPicker}
 *   tenants={tenants}
 *   selectedId={tenant?.id}
 *   onSelect={(id) => {
 *     setTenant(id);
 *     setShowPicker(false);
 *   }}
 *   onClose={() => setShowPicker(false)}
 * />
 * ```
 */

import * as React from 'react';
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  View,
  Text,
  SafeAreaView,
  Platform,
} from 'react-native';

import { cn } from './primitives/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TenantPickerItem {
  id: string;
  name: string;
  /** Logo image source (require() or { uri: string }) */
  logo?: unknown;
  /** Optional description or subtitle */
  description?: string;
}

export interface TenantPickerProps {
  /** Whether the picker is visible */
  visible: boolean;
  /** List of available tenants */
  tenants: TenantPickerItem[];
  /** Currently selected tenant ID */
  selectedId?: string | null;
  /** Called when a tenant is selected */
  onSelect: (tenantId: string) => void;
  /** Called when the picker is dismissed */
  onClose: () => void;
  /** Title shown at the top of the picker */
  title?: string;
  /** Placeholder when no tenants are available */
  emptyMessage?: string;
  /** Custom class name for the container */
  className?: string;
  /** Test ID for testing */
  testID?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TenantPicker({
  visible,
  tenants,
  selectedId,
  onSelect,
  onClose,
  title = 'Select Organization',
  emptyMessage = 'No organizations available',
  className,
  testID,
}: TenantPickerProps) {
  const handleSelect = React.useCallback(
    (tenantId: string) => {
      onSelect(tenantId);
    },
    [onSelect]
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      testID={testID}
    >
      <SafeAreaView className={cn('flex-1 bg-white dark:bg-neutral-900', className)}>
        {/* Header */}
        <View className="flex-row items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-700">
          <Text className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            className={cn(
              'rounded-full p-2',
              Platform.select({
                web: 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
              })
            )}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <Text className="text-lg text-neutral-500">✕</Text>
          </Pressable>
        </View>

        {/* Tenant List */}
        {tenants.length === 0 ? (
          <View className="flex-1 items-center justify-center p-8">
            <Text className="text-center text-neutral-500 dark:text-neutral-400">
              {emptyMessage}
            </Text>
          </View>
        ) : (
          <FlatList
            data={tenants}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingVertical: 8 }}
            renderItem={({ item }) => (
              <TenantPickerRow
                tenant={item}
                isSelected={item.id === selectedId}
                onPress={handleSelect}
              />
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Tenant Row ──────────────────────────────────────────────────────────────

interface TenantPickerRowProps {
  tenant: TenantPickerItem;
  isSelected: boolean;
  onPress: (tenantId: string) => void;
}

function TenantPickerRow({ tenant, isSelected, onPress }: TenantPickerRowProps) {
  const handlePress = React.useCallback(() => {
    onPress(tenant.id);
  }, [tenant.id, onPress]);

  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        'mx-4 my-1 flex-row items-center rounded-xl p-4',
        isSelected
          ? 'bg-primary-50 dark:bg-primary-900/30'
          : 'bg-neutral-50 dark:bg-neutral-800',
        Platform.select({
          web: 'transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-700',
        })
      )}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
    >
      {/* Logo */}
      {tenant.logo ? (
        <Image
          source={tenant.logo as any}
          className="h-12 w-12 rounded-lg"
          resizeMode="contain"
        />
      ) : (
        <View className="h-12 w-12 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-800">
          <Text className="text-xl font-bold text-primary-600 dark:text-primary-300">
            {tenant.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}

      {/* Content */}
      <View className="ml-4 flex-1">
        <Text
          className={cn(
            'text-base font-semibold',
            isSelected
              ? 'text-primary-700 dark:text-primary-300'
              : 'text-neutral-900 dark:text-neutral-100'
          )}
          numberOfLines={1}
        >
          {tenant.name}
        </Text>
        {tenant.description && (
          <Text
            className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400"
            numberOfLines={1}
          >
            {tenant.description}
          </Text>
        )}
      </View>

      {/* Selected indicator */}
      {isSelected && (
        <View className="ml-2 h-6 w-6 items-center justify-center rounded-full bg-primary-500">
          <Text className="text-sm text-white">✓</Text>
        </View>
      )}
    </Pressable>
  );
}

// ─── Inline Tenant Selector ──────────────────────────────────────────────────

export interface TenantSelectorProps {
  /** Currently selected tenant */
  tenant: TenantPickerItem | null;
  /** Called when the selector is pressed */
  onPress: () => void;
  /** Placeholder when no tenant is selected */
  placeholder?: string;
  /** Custom class name */
  className?: string;
  /** Test ID for testing */
  testID?: string;
}

/**
 * Inline tenant selector button that can be placed in forms or headers.
 * Shows the currently selected tenant and opens the picker on press.
 */
export function TenantSelector({
  tenant,
  onPress,
  placeholder = 'Select organization',
  className,
  testID,
}: TenantSelectorProps) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className={cn(
        'flex-row items-center rounded-xl border border-neutral-300 bg-white p-4 dark:border-neutral-600 dark:bg-neutral-800',
        Platform.select({
          web: 'transition-colors hover:border-primary-500 dark:hover:border-primary-400',
        }),
        className
      )}
      accessibilityRole="button"
      accessibilityLabel={tenant ? `Selected: ${tenant.name}` : placeholder}
    >
      {tenant?.logo ? (
        <Image
          source={tenant.logo as any}
          className="h-10 w-10 rounded-lg"
          resizeMode="contain"
        />
      ) : tenant ? (
        <View className="h-10 w-10 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-800">
          <Text className="text-lg font-bold text-primary-600 dark:text-primary-300">
            {tenant.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      ) : (
        <View className="h-10 w-10 items-center justify-center rounded-lg bg-neutral-200 dark:bg-neutral-700">
          <Text className="text-lg text-neutral-400">?</Text>
        </View>
      )}

      <View className="ml-3 flex-1">
        {tenant ? (
          <>
            <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              {tenant.name}
            </Text>
            {tenant.description && (
              <Text className="text-sm text-neutral-500 dark:text-neutral-400">
                {tenant.description}
              </Text>
            )}
          </>
        ) : (
          <Text className="text-base text-neutral-400 dark:text-neutral-500">
            {placeholder}
          </Text>
        )}
      </View>

      {/* Chevron */}
      <Text className="ml-2 text-neutral-400">▼</Text>
    </Pressable>
  );
}
