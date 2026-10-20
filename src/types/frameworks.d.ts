/**
 * Minimal build-time declarations for the optional framework packages.
 *
 * The frameworks are optional peer dependencies and are not installed while
 * this package is built or tested, so these stubs let the helpers type-check.
 * They are not shipped: the published .d.ts files import the real types from
 * `ai`, `@mastra/core/tools` and `@langchain/core/tools` in the user's project.
 * Keep each stub to the generic arity of the real type so those references
 * resolve against any supported version.
 */

declare module "ai" {
  export interface ToolExecutionOptions {
    toolCallId?: string;
    messages?: unknown[];
    abortSignal?: AbortSignal;
  }

  export type Tool<INPUT = unknown, OUTPUT = unknown, CONTEXT = unknown> = {
    description?: string;
    inputSchema: unknown;
    execute?: (input: INPUT, options: ToolExecutionOptions) => PromiseLike<OUTPUT> | OUTPUT;
    __context?: CONTEXT;
  };

  export function tool<INPUT, OUTPUT>(
    definition: Tool<INPUT, OUTPUT> & { execute: (input: INPUT, options: ToolExecutionOptions) => PromiseLike<OUTPUT> | OUTPUT },
  ): Tool<INPUT, OUTPUT>;
}

declare module "@mastra/core/tools" {
  export interface MastraToolDefinition {
    id: string;
    description: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    execute?: (first: unknown, second?: unknown) => Promise<unknown>;
  }

  export interface Tool extends MastraToolDefinition {}

  export function createTool(definition: MastraToolDefinition): Tool;
}

declare module "@langchain/core/tools" {
  export interface DynamicStructuredToolFields {
    name: string;
    description: string;
    schema: unknown;
    func: (input: unknown, runManager?: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>;
  }

  export class DynamicStructuredTool {
    constructor(fields: DynamicStructuredToolFields);
    name: string;
    description: string;
    schema: unknown;
    invoke(input: unknown, config?: unknown): Promise<unknown>;
  }
}
