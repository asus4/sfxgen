import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWorkspace } from '../src/core/agent/memory-workspace';
import { installWebMcpShim, registerWebMcp } from '../src/web/webmcp';
import type { Patch } from '../src/core';

const patch: Patch = {
  format: 'sfxgen/1',
  name: 'p',
  duration: 'auto',
  tracks: [{ id: 'a', source: { type: 'osc', wave: 'sine', freq: 300, env: { decay: 0.1 } } }],
};

let doc: Record<string, unknown>;
beforeEach(() => {
  doc = {};
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

describe('WebMCP', () => {
  it('does nothing without a model context', async () => {
    const h = await registerWebMcp(new MemoryWorkspace());
    expect(h).toMatchObject({ api: 'none', count: 0 });
    h.dispose();
  });

  it('registers every shared tool on the shim and runs them like an agent would', async () => {
    installWebMcpShim();
    const ws = new MemoryWorkspace({ patches: { 'p.sfx.json': patch } });
    const h = await registerWebMcp(ws);
    expect(h).toMatchObject({ api: 'document.modelContext', count: 17 });
    const api = (window as unknown as { __sfxgenWebMcp: import('../src/web/webmcp').WebMcpShimApi }).__sfxgenWebMcp;
    const tools = api.getTools();
    expect(tools.map((t) => t.name)).not.toContain('open_editor');
    expect(tools.find((t) => t.name === 'render_and_analyze')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'export_wav')?.annotations).toMatchObject({ consequentialHint: true });

    const got = await api.executeTool('get_patch', {});
    expect(got.structuredContent).toMatchObject({ name: 'p' });
    const bad = await api.executeTool('edit_patch', { set: { 'tracks.zzz.gain': 1 } });
    expect(bad.isError).toBe(true);

    // Registering again replaces rather than collides.
    expect((await registerWebMcp(ws)).count).toBe(17);
    h.dispose();
  });

  it('rejects duplicate names like the spec and unregisters on abort', async () => {
    installWebMcpShim();
    const ctx = (doc as { modelContext: { registerTool(t: object, o?: { signal: AbortSignal }): Promise<void> } }).modelContext;
    const tool = { name: 't', description: 'd', inputSchema: {}, execute: async () => ({ content: [] }) };
    const ac = new AbortController();
    await ctx.registerTool(tool, { signal: ac.signal });
    await expect(ctx.registerTool(tool)).rejects.toMatchObject({ name: 'InvalidStateError' });
    ac.abort();
    await ctx.registerTool(tool);
  });

  it('copes with the older navigator.modelContext that returns { unregister } and with provideContext', async () => {
    const removed: string[] = [];
    vi.stubGlobal('navigator', {
      modelContext: { registerTool: (t: { name: string }) => ({ unregister: () => removed.push(t.name) }) },
    });
    const h = await registerWebMcp(new MemoryWorkspace());
    expect(h).toMatchObject({ api: 'navigator.modelContext', count: 17 });
    h.dispose();
    expect(removed).toHaveLength(17);

    const provided: unknown[] = [];
    vi.stubGlobal('navigator', { modelContext: { provideContext: (c: unknown) => provided.push(c) } });
    const h2 = await registerWebMcp(new MemoryWorkspace());
    expect(h2.count).toBe(17);
    h2.dispose();
    expect(provided).toHaveLength(2);
  });
});
