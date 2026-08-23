/** The only model-facing native capability in the secretary completion lane. */
export const SECRETARY_MIND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'mind' as const,
    description:
      'Read any authorized Mind item or bounded descendant tree, or create one host-validated proposal. Omit a read id only to use the optional session hint.',
    parameters: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string' as const,
          enum: ['get', 'tree', 'propose'] as const,
          description:
            'Read one exact item, read a bounded descendant tree, or create one proposal.',
        },
        id: {
          type: 'string' as const,
          pattern: '^elm-[a-z0-9]{8}$',
          description:
            'Canonical read item id. Omit to use the optional session hint.',
        },
        depth: {
          type: 'integer' as const,
          minimum: 0,
          maximum: 16,
          description: 'Bounded descendant-tree depth.',
        },
        limit: {
          type: 'integer' as const,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of detailed items returned.',
        },
        title: {
          type: 'string' as const,
          minLength: 1,
          maxLength: 240,
          description: 'Required proposal title for operation propose.',
        },
        body: {
          type: 'string' as const,
          maxLength: 100000,
          description: 'Optional proposal body.',
        },
        kind: {
          type: 'string' as const,
          enum: ['task', 'project', 'idea', 'question', 'reminder'] as const,
          description: 'Optional proposal kind.',
        },
        priority: {
          type: 'integer' as const,
          minimum: 0,
          maximum: 4,
          description: 'Optional proposal priority.',
        },
        parentId: {
          anyOf: [
            { type: 'string' as const, pattern: '^elm-[a-z0-9]{8}$' },
            { type: 'null' as const },
          ],
          description: 'Optional proposal parent.',
        },
        tags: {
          type: 'array' as const,
          maxItems: 32,
          items: { type: 'string' as const, minLength: 1, maxLength: 80 },
          description: 'Optional proposal tags.',
        },
      },
      required: ['operation'] as ['operation'],
      additionalProperties: false as const,
    },
  },
};
