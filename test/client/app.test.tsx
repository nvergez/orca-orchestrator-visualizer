import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';

/**
 * Seam 2 (#12): the frontend is tested by rendering it, in jsdom, through the same
 * Vitest run as the server seam. The panels — and the canned `StreamEvent` that feeds
 * them — arrive with their own tickets; this proves the seam exists and works.
 */
describe('<App>', () => {
  it('renders', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'orca-viz' })).toBeVisible();
  });
});
