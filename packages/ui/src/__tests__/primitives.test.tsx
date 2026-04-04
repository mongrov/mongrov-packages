/**
 * Tests for UI primitives
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button, buttonVariants, buttonTextVariants } from '../primitives/button'
import { Text, TextClassContext, textVariants } from '../primitives/text'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../primitives/card'
import { Separator } from '../primitives/separator'
import { Skeleton } from '../primitives/skeleton'
import { cn } from '../primitives/utils'

// ─── Button Tests ────────────────────────────────────────────────────────────

describe('Button', () => {
  it('should render with label', () => {
    render(<Button label="Click me" testID="button" />)
    expect(screen.getByTestId('button')).toBeInTheDocument()
  })

  it('should render with children', () => {
    render(
      <Button testID="button">
        <span>Child content</span>
      </Button>
    )
    expect(screen.getByTestId('button')).toBeInTheDocument()
    expect(screen.getByText('Child content')).toBeInTheDocument()
  })

  it('should handle onPress', () => {
    const onPress = jest.fn()
    render(<Button label="Click" onPress={onPress} testID="button" />)

    fireEvent.click(screen.getByTestId('button'))
    expect(onPress).toHaveBeenCalled()
  })

  it('should be disabled when disabled prop is true', () => {
    const onPress = jest.fn()
    render(<Button label="Click" disabled onPress={onPress} testID="button" />)

    const button = screen.getByTestId('button')
    expect(button).toHaveAttribute('disabled')
  })

  it('should be disabled when loading', () => {
    render(<Button label="Click" loading testID="button" />)

    const button = screen.getByTestId('button')
    expect(button).toHaveAttribute('disabled')
  })

  it('should show spinner element when loading', () => {
    render(<Button label="Click" loading testID="button" />)
    const button = screen.getByTestId('button')
    // When loading, there should be a child element (ActivityIndicator)
    expect(button.querySelector('span')).toBeInTheDocument()
  })

  it('should apply custom className', () => {
    render(<Button label="Click" className="custom-class" testID="button" />)
    const button = screen.getByTestId('button')
    expect(button).toHaveClass('custom-class')
  })
})

describe('buttonVariants', () => {
  it('should return a string of classes', () => {
    const classes = buttonVariants({})
    expect(typeof classes).toBe('string')
    expect(classes.length).toBeGreaterThan(0)
  })

  it('should accept variant prop', () => {
    const classes = buttonVariants({ variant: 'destructive' })
    expect(typeof classes).toBe('string')
  })

  it('should accept size prop', () => {
    const classes = buttonVariants({ size: 'lg' })
    expect(typeof classes).toBe('string')
  })
})

describe('buttonTextVariants', () => {
  it('should return a string of classes', () => {
    const classes = buttonTextVariants({})
    expect(typeof classes).toBe('string')
    expect(classes.length).toBeGreaterThan(0)
  })

  it('should accept variant prop', () => {
    const classes = buttonTextVariants({ variant: 'outline' })
    expect(typeof classes).toBe('string')
  })
})

// ─── Text Tests ──────────────────────────────────────────────────────────────

describe('Text', () => {
  it('should render text content', () => {
    render(<Text testID="text">Hello World</Text>)
    expect(screen.getByTestId('text')).toBeInTheDocument()
    expect(screen.getByText('Hello World')).toBeInTheDocument()
  })

  it('should apply variant classes', () => {
    render(<Text variant="h1" testID="text">Heading</Text>)
    const text = screen.getByTestId('text')
    expect(text).toHaveClass('text-4xl')
  })

  it('should apply custom className', () => {
    render(<Text className="custom-text" testID="text">Text</Text>)
    const text = screen.getByTestId('text')
    expect(text).toHaveClass('custom-text')
  })

  it('should set heading role for h1-h4 variants', () => {
    render(<Text variant="h1" testID="text">Heading</Text>)
    const text = screen.getByTestId('text')
    expect(text).toHaveAttribute('role', 'heading')
  })

  it('should set aria-level for heading variants', () => {
    render(<Text variant="h2" testID="text">Heading 2</Text>)
    const text = screen.getByTestId('text')
    expect(text).toHaveAttribute('aria-level', '2')
  })

  it('should use TextClassContext', () => {
    render(
      <TextClassContext.Provider value="context-class">
        <Text testID="text">Text</Text>
      </TextClassContext.Provider>
    )
    const text = screen.getByTestId('text')
    expect(text).toHaveClass('context-class')
  })
})

describe('textVariants', () => {
  it('should return a string of classes', () => {
    const classes = textVariants({})
    expect(typeof classes).toBe('string')
    expect(classes.length).toBeGreaterThan(0)
  })

  it('should accept h1 variant', () => {
    const classes = textVariants({ variant: 'h1' })
    expect(typeof classes).toBe('string')
  })

  it('should accept muted variant', () => {
    const classes = textVariants({ variant: 'muted' })
    expect(typeof classes).toBe('string')
  })

  it('should accept code variant', () => {
    const classes = textVariants({ variant: 'code' })
    expect(typeof classes).toBe('string')
  })
})

// ─── Card Tests ──────────────────────────────────────────────────────────────

describe('Card', () => {
  it('should render children', () => {
    render(
      <Card testID="card">
        <span>Card content</span>
      </Card>
    )
    expect(screen.getByTestId('card')).toBeInTheDocument()
    expect(screen.getByText('Card content')).toBeInTheDocument()
  })

  it('should apply custom className', () => {
    render(<Card className="custom-card" testID="card">Content</Card>)
    const card = screen.getByTestId('card')
    expect(card).toHaveClass('custom-card')
  })

  it('should provide TextClassContext', () => {
    // Card provides TextClassContext for its children
    render(
      <Card testID="card">
        <Text testID="text">Inner text</Text>
      </Card>
    )
    expect(screen.getByTestId('card')).toBeInTheDocument()
  })
})

describe('CardHeader', () => {
  it('should render children', () => {
    render(<CardHeader testID="header">Header content</CardHeader>)
    expect(screen.getByTestId('header')).toBeInTheDocument()
  })

  it('should apply padding classes', () => {
    render(<CardHeader testID="header">Header</CardHeader>)
    const header = screen.getByTestId('header')
    expect(header).toHaveClass('px-6')
  })
})

describe('CardTitle', () => {
  it('should render as heading', () => {
    render(<CardTitle testID="title">Title</CardTitle>)
    const title = screen.getByTestId('title')
    expect(title).toHaveAttribute('role', 'heading')
  })

  it('should have aria-level 3', () => {
    render(<CardTitle testID="title">Title</CardTitle>)
    const title = screen.getByTestId('title')
    expect(title).toHaveAttribute('aria-level', '3')
  })
})

describe('CardDescription', () => {
  it('should render description text', () => {
    render(<CardDescription testID="desc">Description</CardDescription>)
    expect(screen.getByTestId('desc')).toBeInTheDocument()
  })

  it('should apply muted text classes', () => {
    render(<CardDescription testID="desc">Description</CardDescription>)
    const desc = screen.getByTestId('desc')
    expect(desc).toHaveClass('text-neutral-500')
  })
})

describe('CardContent', () => {
  it('should render children', () => {
    render(<CardContent testID="content">Content</CardContent>)
    expect(screen.getByTestId('content')).toBeInTheDocument()
  })
})

describe('CardFooter', () => {
  it('should render children', () => {
    render(<CardFooter testID="footer">Footer</CardFooter>)
    expect(screen.getByTestId('footer')).toBeInTheDocument()
  })

  it('should apply flex-row layout', () => {
    render(<CardFooter testID="footer">Footer</CardFooter>)
    const footer = screen.getByTestId('footer')
    expect(footer).toHaveClass('flex-row')
  })
})

// ─── Separator Tests ─────────────────────────────────────────────────────────

describe('Separator', () => {
  it('should render horizontal by default', () => {
    render(<Separator testID="separator" />)
    const separator = screen.getByTestId('separator')
    expect(separator).toHaveClass('h-[1px]')
    expect(separator).toHaveClass('w-full')
  })

  it('should render vertical orientation', () => {
    render(<Separator orientation="vertical" testID="separator" />)
    const separator = screen.getByTestId('separator')
    expect(separator).toHaveClass('w-[1px]')
    expect(separator).toHaveClass('h-full')
  })

  it('should apply custom className', () => {
    render(<Separator className="my-separator" testID="separator" />)
    const separator = screen.getByTestId('separator')
    expect(separator).toHaveClass('my-separator')
  })
})

// ─── Skeleton Tests ──────────────────────────────────────────────────────────

describe('Skeleton', () => {
  it('should render', () => {
    render(<Skeleton testID="skeleton" />)
    expect(screen.getByTestId('skeleton')).toBeInTheDocument()
  })

  it('should apply default classes', () => {
    render(<Skeleton testID="skeleton" />)
    const skeleton = screen.getByTestId('skeleton')
    expect(skeleton).toHaveClass('bg-neutral-200')
    expect(skeleton).toHaveClass('rounded-md')
  })

  it('should apply custom className', () => {
    render(<Skeleton className="w-32 h-4" testID="skeleton" />)
    const skeleton = screen.getByTestId('skeleton')
    expect(skeleton).toHaveClass('w-32')
    expect(skeleton).toHaveClass('h-4')
  })
})

// ─── Utils Tests ─────────────────────────────────────────────────────────────

describe('cn utility', () => {
  it('should merge class names', () => {
    const result = cn('class1', 'class2')
    expect(result).toContain('class1')
    expect(result).toContain('class2')
  })

  it('should handle undefined values', () => {
    const result = cn('class1', undefined, 'class2')
    expect(result).toContain('class1')
    expect(result).toContain('class2')
  })

  it('should handle conditional classes', () => {
    const result = cn('base', false && 'hidden', true && 'visible')
    expect(result).toContain('base')
    expect(result).toContain('visible')
    expect(result).not.toContain('hidden')
  })
})
