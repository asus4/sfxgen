/**
 * `sfxgen mcp`: an MCP server over stdio exposing the shared agent tools (src/core/agent/tools.ts) on patch files
 * under a directory, plus `open_editor`, which starts the editor server in this process so `play` and a person's
 * edits flow through it. Stdout belongs to the protocol: everything else goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, callTool, type ToolDef, type ToolResult } from '../core/agent/tools';
import { FileWorkspace } from './file-workspace';
import { startServer, type RunningServer } from './server';
import pkg from '../../package.json';

export interface McpOptions {
  /** Directory the patch files live in; relative refs resolve against it. */
  root: string;
}

const INSTRUCTIONS = [
  'sfxgen designs sound effects as JSON patches that render deterministically.',
  'Workflow: describe_format once, then list_templates + new_from_template (or set_patch), set_controls for the knobs a person should get,',
  'then loop edit_patch -> render_and_analyze (with spectrogram: true when shape matters) until the numbers and image match the intent.',
  'For a set of sounds made to be heard together (a game\'s sound effects): get_project, edit_project, balance_project to level them, build_project to write the WAVs.',
  'Call open_editor so the person can see and tweak the patch, play it for them, and check get_human_changes before editing after they have.',
].join(' ');

/** The one tool only this host offers. */
function openEditorTool(ws: FileWorkspace, state: { server?: RunningServer }): ToolDef {
  return {
    name: 'open_editor',
    title: 'Open the editor',
    description:
      'Starts the sfxgen editor for this project folder and returns its URL: give it to the person so they can see the patch, tweak its controls and hear it. Once it is open, `play` makes sound there and their edits can be read back with get_human_changes.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Patch to open first, relative to the project folder.' },
        open_browser: { type: 'boolean', description: 'Also open the default browser on this machine. Default true.' },
      },
      additionalProperties: false,
    },
    annotations: { consequentialHint: true, idempotentHint: true },
    hostOnly: true,
    async run(_ws, args) {
      const file = typeof args.file === 'string' ? ws.normalize(args.file) : undefined;
      if (!state.server) {
        state.server = await startServer({ root: ws.root, port: 0, open: false, workspace: ws, log: (m) => process.stderr.write(`${m}\n`) });
      }
      const url = file ? `${state.server.url.split('?')[0]}?file=${encodeURIComponent(file)}` : state.server.url;
      if (args.open_browser !== false) {
        const { spawn } = await import('node:child_process');
        const [cmd, a] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
        try {
          const child = spawn(cmd, a as string[], { stdio: 'ignore', detached: true });
          child.on('error', () => {});
          child.unref();
        } catch {
          /* the URL is returned either way */
        }
      }
      return { text: `The editor is at ${url}. Give this link to the person; ${state.server.clientCount()} page(s) are connected now.`, data: { url } };
    },
  };
}

function toMcpResult(r: ToolResult): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: r.text }];
  if (r.image) content.push({ type: 'image', data: Buffer.from(r.image.data).toString('base64'), mimeType: r.image.mimeType });
  const out: CallToolResult = { content };
  if (r.isError) out.isError = true;
  return out;
}

/** Runs the MCP server over stdio until the client disconnects. */
export async function startMcp(opts: McpOptions): Promise<void> {
  const ws = new FileWorkspace(opts.root);
  ws.playHint = 'No editor is open. Call open_editor to start one and give the person its URL, then call play again.';
  const state: { server?: RunningServer } = {};
  const tools = [...TOOLS, openEditorTool(ws, state)];

  const server = new Server({ name: 'sfxgen', version: pkg.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
      annotations: {
        title: t.title,
        readOnlyHint: t.annotations?.readOnlyHint ?? false,
        destructiveHint: t.annotations?.readOnlyHint ? false : (t.annotations?.destructiveHint ?? false),
        idempotentHint: t.annotations?.idempotentHint ?? false,
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(ws, req.params.name, req.params.arguments ?? {}, tools);
    return toMcpResult(result);
  });

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((ok) => {
    server.onclose = () => ok();
  });
  const shutdown = async () => {
    await state.server?.close();
    await server.close().catch(() => {});
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  // The client closing stdin is how a stdio server is told to stop.
  process.stdin.once('end', () => void shutdown());
  await server.connect(transport);
  process.stderr.write(`sfxgen MCP server ready (${tools.length} tools), patches in ${ws.root}\n`);
  await closed;
  await state.server?.close();
}
