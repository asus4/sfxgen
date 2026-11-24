/**
 * WebMCP: the same tools the MCP server offers (src/core/agent/tools.ts), registered on the page so an in-browser
 * agent can design sounds in the open editor.
 *
 * The spec (W3C Web Machine Learning CG, "WebMCP") puts the API on `document.modelContext`; older Chrome builds and
 * the MCP-B polyfill use `navigator.modelContext`, some with `registerTool` returning `{ unregister() }`, some with
 * `provideContext({ tools })`. All three are handled; nothing here throws when none exists.
 */
import type { Workspace } from '../core/agent/workspace';
import { TOOLS, callTool, type ToolDef, type ToolResult } from '../core/agent/tools';

export interface WebMcpHandle {
  /** Where the tools went: the spec's document.modelContext, the older navigator.modelContext, or nowhere. */
  api: 'document.modelContext' | 'navigator.modelContext' | 'none';
  /** Tools registered. */
  count: number;
  /** Unregisters every tool. */
  dispose(): void;
}

/** What `execute` returns to the browser (which JSON-stringifies it for the agent). */
export interface WebMcpResult {
  content: ({ type: 'text'; text: string })[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  execute(input: unknown, client?: unknown): Promise<WebMcpResult>;
}

interface ModelContextLike {
  registerTool?(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  provideContext?(ctx: { tools: WebMcpTool[] }): unknown;
}

/** Inline images above this many bytes are left out: the result would swamp the agent's context. */
const MAX_INLINE_IMAGE = 150_000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function toWebResult(r: ToolResult): WebMcpResult {
  let text = r.text;
  if (r.image) {
    if (r.image.data.length <= MAX_INLINE_IMAGE) text += `\n\n![spectrogram](data:${r.image.mimeType};base64,${toBase64(r.image.data)})`;
    else text += `\n\n(A ${Math.round(r.image.data.length / 1024)} KB spectrogram image was made but is too large to return here; use the written description and the numbers.)`;
  }
  const out: WebMcpResult = { content: [{ type: 'text', text }] };
  if (r.data !== undefined) out.structuredContent = r.data;
  if (r.isError) out.isError = true;
  return out;
}

function toWebTool(ws: Workspace, tool: ToolDef): WebMcpTool {
  const annotations: WebMcpTool['annotations'] = {};
  if (tool.annotations?.readOnlyHint !== undefined) annotations.readOnlyHint = tool.annotations.readOnlyHint;
  if (tool.annotations?.consequentialHint !== undefined) annotations.consequentialHint = tool.annotations.consequentialHint;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations,
    execute: async (input) => toWebResult(await callTool(ws, tool.name, input ?? {})),
  };
}

function findContext(): { ctx: ModelContextLike; api: WebMcpHandle['api'] } | undefined {
  if (typeof document !== 'undefined') {
    const c = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
    if (c) return { ctx: c, api: 'document.modelContext' };
  }
  if (typeof navigator !== 'undefined') {
    const c = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
    if (c) return { ctx: c, api: 'navigator.modelContext' };
  }
  return undefined;
}

let active: WebMcpHandle | undefined;

/** Registers every sfxgen tool on the page's model context, if the browser has one. Safe to call when it doesn't. */
export async function registerWebMcp(ws: Workspace): Promise<WebMcpHandle> {
  active?.dispose();
  active = undefined;
  const found = findContext();
  if (!found) return { api: 'none', count: 0, dispose() {} };
  const { ctx, api } = found;
  const tools = TOOLS.filter((t) => !t.hostOnly).map((t) => toWebTool(ws, t));
  const abort = new AbortController();
  const undo: (() => void)[] = [];
  let count = 0;

  if (typeof ctx.registerTool === 'function') {
    for (const tool of tools) {
      try {
        const result = await ctx.registerTool(tool, { signal: abort.signal });
        const unregister = (result as { unregister?: () => void } | undefined)?.unregister;
        if (typeof unregister === 'function') undo.push(() => unregister.call(result));
        count++;
      } catch (err) {
        // A duplicate name (a previous registration still there) or a rejected tool: skip it, keep the rest.
        console.warn(`sfxgen: WebMCP did not register ${tool.name}:`, err);
      }
    }
  } else if (typeof ctx.provideContext === 'function') {
    await ctx.provideContext({ tools });
    undo.push(() => void ctx.provideContext?.({ tools: [] }));
    count = tools.length;
  }

  const handle: WebMcpHandle = {
    api,
    count,
    dispose() {
      if (active === handle) active = undefined;
      abort.abort();
      for (const u of undo) {
        try {
          u();
        } catch {
          /* already gone */
        }
      }
      undo.length = 0;
    },
  };
  active = handle;
  return handle;
}

// ---- Shim ----------------------------------------------------------------------------------------

export interface WebMcpShimApi {
  getTools(): { name: string; title?: string; description: string; inputSchema: object; annotations?: object }[];
  /**
   * Calls a registered tool the way an agent would (by name, or with a tool from getTools) and resolves with what
   * `execute` returned, after the JSON round trip the browser applies.
   */
  executeTool(tool: string | { name: string }, input?: unknown): Promise<WebMcpResult>;
}

declare global {
  interface Window {
    __sfxgenWebMcp?: WebMcpShimApi;
  }
}

/**
 * For development and tests: installs a minimal `document.modelContext` when the browser has none, and exposes
 * `window.__sfxgenWebMcp` (getTools, executeTool) so a script or the console can call tools as an agent would.
 */
export function installWebMcpShim(): void {
  if (typeof document === 'undefined') return;
  if ((document as unknown as { modelContext?: unknown }).modelContext) return;
  const registry = new Map<string, WebMcpTool>();
  const nameOk = /^[A-Za-z0-9_.-]{1,128}$/;
  const ctx: ModelContextLike & { getTools(): WebMcpTool[] } = {
    async registerTool(tool, options) {
      if (!tool || typeof tool.name !== 'string' || !nameOk.test(tool.name)) throw new TypeError('Invalid tool name');
      if (!tool.description) throw new TypeError('Tool description is required');
      if (typeof tool.execute !== 'function') throw new TypeError('Tool execute is required');
      if (registry.has(tool.name)) throw new DOMException(`A tool named ${tool.name} is already registered`, 'InvalidStateError');
      registry.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => registry.delete(tool.name), { once: true });
    },
    getTools: () => [...registry.values()],
  };
  // The spec's consumer side: getTools() resolves with the tools, executeTool(tool, input) with the result as the
  // JSON string the browser hands an agent.
  const spec = ctx as unknown as Record<string, unknown>;
  spec.getTools = async () => [...registry.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
  spec.executeTool = async (tool: { name: string } | string, input?: unknown) => {
    const name = typeof tool === 'string' ? tool : tool?.name;
    const t = registry.get(name);
    if (!t) throw new DOMException(`No tool named ${name}`, 'NotFoundError');
    return JSON.stringify(await t.execute(input ?? {}, { signal: new AbortController().signal }));
  };
  Object.defineProperty(document, 'modelContext', { value: ctx, configurable: true });
  window.__sfxgenWebMcp = {
    getTools: () => [...registry.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
    async executeTool(toolOrName, input) {
      const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;
      const tool = registry.get(name);
      if (!tool) throw new Error(`No tool "${name}". Registered: ${[...registry.keys()].join(', ') || 'none'}`);
      // The browser would JSON-stringify the result for the agent; do the same so tests see what an agent sees.
      return JSON.parse(JSON.stringify(await tool.execute(input ?? {}, {})));
    },
  };
}
