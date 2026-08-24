/** The only model-facing native capability in the secretary completion lane. */
export const SECRETARY_MIND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'mind' as const,
    description:
      'Globally list/search or read authorized Mind items, add a durable comment/reply, or create one host-validated proposal. Omit a get/tree id only to use the optional session hint.',
    parameters: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string' as const,
          enum: ['get', 'list', 'tree', 'comment', 'reply', 'propose'] as const,
          description:
            'Read one item, list/search globally, read a descendant tree, add a comment/reply, or create a proposal.',
        },
        id: {
          type: 'string' as const,
          pattern: '^elm-[a-z0-9]{8}$',
          description:
            'Canonical read item id. Omit to use the optional session hint.',
        },
        query: {
          type: 'string' as const,
          maxLength: 500,
          description: 'Optional global list/search query.',
        },
        statuses: {
          type: 'array' as const,
          maxItems: 8,
          items: {
            type: 'string' as const,
            enum: [
              'proposal',
              'inbox',
              'open',
              'in_progress',
              'waiting',
              'done',
              'cancelled',
            ] as const,
          },
        },
        kinds: {
          type: 'array' as const,
          maxItems: 5,
          items: {
            type: 'string' as const,
            enum: ['task', 'project', 'idea', 'question', 'reminder'] as const,
          },
        },
        includeArchived: {
          type: 'boolean' as const,
          description: 'Include archived items in list results.',
        },
        offset: {
          type: 'integer' as const,
          minimum: 0,
          maximum: 10000,
          description: 'Global list result offset.',
        },
        commentId: {
          type: 'integer' as const,
          minimum: 1,
          description: 'Existing comment id for operation reply.',
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
