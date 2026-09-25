import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardTemplatesDocument, DeleteBoardTemplateDocument, SaveBoardTemplateDocument } from '@/lib/graphql';
import { SaveTemplateDialog } from '../save-template-dialog';
import { TemplateManager } from '../template-manager';

const PIPELINE = {
  __typename: 'BoardTemplate' as const,
  id: 't1',
  name: 'Pipeline',
  lanes: [{ name: 'Intake' }, { name: 'Review' }, { name: 'Done', isDone: true }],
};

function listed(templates: (typeof PIPELINE)[]) {
  return { request: { query: BoardTemplatesDocument }, result: { data: { boardTemplates: templates } } };
}

describe('TemplateManager', () => {
  it('lists templates by their lanes, and deletes one', async () => {
    const user = userEvent.setup();
    const remove = vi.fn(() => ({ data: { deleteBoardTemplate: { __typename: 'BoardTemplate', id: 't1' } } }));
    render(
      <MockedProvider
        mocks={[
          listed([PIPELINE]),
          { request: { query: DeleteBoardTemplateDocument, variables: { id: 't1' } }, result: remove },
          listed([]),
        ]}
      >
        <TemplateManager />
      </MockedProvider>,
    );

    expect(await screen.findByText('Intake, Review, Done')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Pipeline' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    expect(await screen.findByText('No templates yet.')).toBeInTheDocument();
  });
});

describe('SaveTemplateDialog', () => {
  it('saves under the name given, the project’s by default', async () => {
    const user = userEvent.setup();
    const save = vi.fn(() => ({ data: { saveBoardTemplate: { ...PIPELINE, name: 'Kitchen flow' } } }));
    const onSaved = vi.fn();
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: SaveBoardTemplateDocument, variables: { projectId: 'p1', name: 'Kitchen flow' } },
            result: save,
          },
          listed([PIPELINE]),
        ]}
      >
        <SaveTemplateDialog open onOpenChange={() => {}} projectId="p1" projectName="Kitchen" onSaved={onSaved} />
      </MockedProvider>,
    );

    const name = await screen.findByLabelText('Template name');
    expect(name).toHaveValue('Kitchen');
    await user.type(name, ' flow');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith('Kitchen flow'));
    expect(save).toHaveBeenCalled();
  });
});
