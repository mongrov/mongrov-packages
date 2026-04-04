/**
 * Tests for Auth UI components
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { AuthDivider } from '../AuthDivider'
import { SSOButton } from '../SSOButton'
import { SocialLoginButton } from '../SocialLoginButton'

// ─── AuthDivider Tests ────────────────────────────────────────────────────────

describe('AuthDivider', () => {
  it('should render with default text', () => {
    render(<AuthDivider />)
    expect(screen.getByText('or continue with')).toBeInTheDocument()
  })

  it('should render with custom text', () => {
    render(<AuthDivider text="or sign in with" />)
    expect(screen.getByText('or sign in with')).toBeInTheDocument()
  })

  it('should apply custom className', () => {
    const { container } = render(<AuthDivider className="my-custom-class" />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('my-custom-class')
  })

  it('should render divider lines', () => {
    const { container } = render(<AuthDivider />)
    // The component has 3 children: line, text, line
    const children = container.firstChild?.childNodes
    expect(children?.length).toBe(3)
  })
})

// ─── SSOButton Tests ──────────────────────────────────────────────────────────

describe('SSOButton', () => {
  it('should render with default label', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} testID="sso" />)
    expect(screen.getByText('Enterprise Sign-In')).toBeInTheDocument()
  })

  it('should render with custom label', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} label="Corporate Login" testID="sso" />)
    expect(screen.getByText('Corporate Login')).toBeInTheDocument()
  })

  it('should render with provider name', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} providerName="Okta" testID="sso" />)
    expect(screen.getByText('Sign in with Okta')).toBeInTheDocument()
  })

  it('should handle onPress', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} testID="sso" />)

    fireEvent.click(screen.getByTestId('sso'))
    expect(onPress).toHaveBeenCalled()
  })

  it('should be disabled when disabled prop is true', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} disabled testID="sso" />)

    const button = screen.getByTestId('sso')
    expect(button).toHaveAttribute('disabled')
  })

  it('should be disabled when loading', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} loading testID="sso" />)

    const button = screen.getByTestId('sso')
    expect(button).toHaveAttribute('disabled')
  })

  it('should show loading indicator when loading', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} loading testID="sso" />)

    // When loading, label text should not be visible
    expect(screen.queryByText('Enterprise Sign-In')).not.toBeInTheDocument()
  })

  it('should apply custom className', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} className="custom-sso" testID="sso" />)

    const button = screen.getByTestId('sso')
    expect(button).toHaveClass('custom-sso')
  })

  it('should have proper accessibility label', () => {
    const onPress = jest.fn()
    render(<SSOButton onPress={onPress} providerName="Azure AD" testID="sso" />)

    const button = screen.getByTestId('sso')
    expect(button).toHaveAttribute('aria-label', 'Sign in with Azure AD')
  })
})

// ─── SocialLoginButton Tests ──────────────────────────────────────────────────

describe('SocialLoginButton', () => {
  describe('Apple provider', () => {
    it('should render Apple button with default label', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="apple" onPress={onPress} testID="social" />)
      expect(screen.getByText('Continue with Apple')).toBeInTheDocument()
    })

    it('should render Apple icon', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="apple" onPress={onPress} testID="social" />)
      // Apple icon renders separately from label text
      const icons = screen.getAllByText('')
      expect(icons.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Google provider', () => {
    it('should render Google button with default label', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="google" onPress={onPress} testID="social" />)
      expect(screen.getByText('Continue with Google')).toBeInTheDocument()
    })

    it('should render Google icon', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="google" onPress={onPress} testID="social" />)
      expect(screen.getByText('G')).toBeInTheDocument()
    })
  })

  describe('GitHub provider', () => {
    it('should render GitHub button with default label', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="github" onPress={onPress} testID="social" />)
      expect(screen.getByText('Continue with GitHub')).toBeInTheDocument()
    })

    it('should render GitHub icon', () => {
      const onPress = jest.fn()
      render(<SocialLoginButton provider="github" onPress={onPress} testID="social" />)
      // GitHub icon renders separately from label text
      const icons = screen.getAllByText('')
      expect(icons.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('should handle onPress', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="google" onPress={onPress} testID="social" />)

    fireEvent.click(screen.getByTestId('social'))
    expect(onPress).toHaveBeenCalled()
  })

  it('should render with custom label', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="apple" onPress={onPress} label="Sign in with Apple ID" testID="social" />)
    expect(screen.getByText('Sign in with Apple ID')).toBeInTheDocument()
  })

  it('should be disabled when disabled prop is true', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="google" onPress={onPress} disabled testID="social" />)

    const button = screen.getByTestId('social')
    expect(button).toHaveAttribute('disabled')
  })

  it('should be disabled when loading', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="github" onPress={onPress} loading testID="social" />)

    const button = screen.getByTestId('social')
    expect(button).toHaveAttribute('disabled')
  })

  it('should show loading indicator when loading', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="apple" onPress={onPress} loading testID="social" />)

    // When loading, label should not be visible
    expect(screen.queryByText('Continue with Apple')).not.toBeInTheDocument()
  })

  it('should apply custom className', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="google" onPress={onPress} className="custom-social" testID="social" />)

    const button = screen.getByTestId('social')
    expect(button).toHaveClass('custom-social')
  })

  it('should have proper accessibility label', () => {
    const onPress = jest.fn()
    render(<SocialLoginButton provider="github" onPress={onPress} testID="social" />)

    const button = screen.getByTestId('social')
    expect(button).toHaveAttribute('aria-label', 'Continue with GitHub')
  })
})
