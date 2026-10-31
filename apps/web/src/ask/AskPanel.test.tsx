import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { RagAnswer } from '@archi-graph/shared';

const ask = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    ask: (...a: unknown[]) => ask(...a),
  },
}));

import { AskPanel } from './AskPanel';

const answer: RagAnswer = {
  answer: 'The web app renders the graph.',
  citations: [
    { entityId: 'e-web', code: 'LLD-01', shortTitle: 'Web' },
    { entityId: 'e-api', code: 'SAD-01', shortTitle: 'API' },
  ],
};

describe('AskPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ask.mockResolvedValue(answer);
  });

  it('asks a question and shows the answer + clickable citations', async () => {
    const onSelectEntity = vi.fn();
    render(<AskPanel branchId="main" onSelectEntity={onSelectEntity} />);

    fireEvent.change(screen.getByLabelText(/question/i), {
      target: { value: 'What renders the graph?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /ask/i }));

    await waitFor(() => expect(ask).toHaveBeenCalledWith('main', 'What renders the graph?'));
    expect(await screen.findByText('The web app renders the graph.')).toBeInTheDocument();

    // Clicking a citation selects the source node by entityId.
    fireEvent.click(screen.getByRole('button', { name: /Web/ }));
    expect(onSelectEntity).toHaveBeenCalledWith('e-web');
  });
});
