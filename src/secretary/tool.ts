/** The only model-facing native capability in the secretary completion lane. */
export const SECRETARY_MIND_TOOL = {
  type: "function" as const,
  function: {
    name: "mind" as const,
    description:
      "Read the Mind item bound to this secretary session or its descendants. The secretary runtime executes this call through the token-bound secretary Mind endpoint.",
    parameters: {
      type: "object" as const,
      properties: {
        operation: {
          type: "string" as const,
          enum: ["get", "tree"] as const,
          description: "Read one exact item, or a bounded descendant tree.",
        },
        id: {
          type: "string" as const,
          pattern: "^elm-[a-z0-9]{8}$",
          description: "Canonical item id. Omit to use the session root.",
        },
        depth: {
          type: "integer" as const,
          minimum: 0,
          maximum: 16,
          description:
            "Tree depth, including only descendants of the selected item.",
        },
        limit: {
          type: "integer" as const,
          minimum: 1,
          maximum: 100,
          description: "Maximum number of detailed items returned.",
        },
      },
      required: ["operation"] as ["operation"],
      additionalProperties: false as const,
    },
  },
};
