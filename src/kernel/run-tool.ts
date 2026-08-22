import type { RunTool } from "../llm/llm.js";

export const WORKER_RUN_TOOL: RunTool = {
  type: "function",
  function: {
    name: "run",
    description:
      "Run JavaScript in this worker's persistent isolated workspace. Returns a capped preview plus console output. Continue until the linked Mind task is complete, then report through the worker mailbox.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to execute." },
        detail: {
          type: "string",
          maxLength: 120,
          description:
            "Required single-line description of the intended effect: 1 to 10 words.",
        },
      },
      required: ["code", "detail"],
      additionalProperties: false,
    },
  },
};
