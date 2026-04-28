'use strict';
/**
 * mcp-bridge.cjs — MCP bridge running as a separate child process.
 * Vite spawns this file so esbuild never touches it.
 * Communicates with the Vite dev server via HTTP on a random port
 * (port is sent to parent via IPC: process.send({ port })).
 */

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// ── State ────────────────────────────────────────────────────────────────────
const clients = new Map();   // name → { client, config }
const statuses = {};         // name → { status, error?, tools }
const toolsCache = {};       // name → tool[]

// ── Helpers ──────────────────────────────────────────────────────────────────
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function getMcpConfigs(agentName) {
  const configs = {};
  const globalPath = path.join(os.homedir(), '.pi', 'mcp.json');
  const agentDefaultPath = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');

  const g = readJson(globalPath);
  if (g) Object.assign(configs, g.mcpServers || {});

  const a = readJson(agentDefaultPath);
  if (a) Object.assign(configs, a.mcpServers || {});

  if (agentName) {
    const agentPath = path.join(os.homedir(), 'agentes', agentName, '.pi', 'mcp.json');
    const ag = readJson(agentPath);
    if (ag) {
      Object.assign(configs, ag.mcpServers || {});
      console.error(`[MCP bridge] Loaded mcp.json for agent: ${agentName}`);
    }
  }
  return configs;
}

function disconnect(name) {
  const entry = clients.get(name);
  if (entry) {
    try { entry.client.close(); } catch {}
    clients.delete(name);
  }
  delete statuses[name];
  delete toolsCache[name];
}

async function connect(name, config) {
  statuses[name] = { status: 'connecting', tools: [] };
  console.error(`[MCP bridge] Connecting to ${name}...`);
  try {
    const client = new Client({ name: 'pi-web-ui', version: '1.0.0' }, { capabilities: {} });
    let transport;

    if (config.url) {
      // Try Streamable HTTP first, fallback to SSE
      try {
        transport = new StreamableHTTPClientTransport(new URL(config.url));
        await client.connect(transport);
      } catch (e) {
        console.error(`[MCP bridge] ${name}: StreamableHTTP failed (${e.message}), trying SSE...`);
        const c2 = new Client({ name: 'pi-web-ui', version: '1.0.0' }, { capabilities: {} });
        transport = new SSEClientTransport(new URL(config.url));
        await c2.connect(transport);
        const tools = (await c2.listTools()).tools || [];
        clients.set(name, { client: c2, config });
        statuses[name] = { status: 'connected', tools };
        toolsCache[name] = tools;
        console.error(`[MCP bridge] ${name}: connected via SSE (${tools.length} tools)`);
        return;
      }
    } else if (config.command) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) },
      });
      await client.connect(transport);
    } else {
      throw new Error('Invalid config: no url or command');
    }

    clients.set(name, { client, config });
    const tools = (await client.listTools()).tools || [];
    statuses[name] = { status: 'connected', tools };
    toolsCache[name] = tools;
    console.error(`[MCP bridge] ${name}: connected (${tools.length} tools)`);
  } catch (e) {
    statuses[name] = { status: 'error', error: e.message, tools: [] };
    console.error(`[MCP bridge] ${name}: error — ${e.message}`);
  }
}

async function loadAndConnect(agentName) {
  const configs = getMcpConfigs(agentName);

  // Disconnect removed servers
  for (const name of clients.keys()) {
    if (!configs[name]) disconnect(name);
  }

  // Connect new or retry errored
  const promises = [];
  for (const [name, config] of Object.entries(configs)) {
    if (!clients.has(name) || statuses[name]?.status === 'error') {
      promises.push(connect(name, config));
    }
  }
  await Promise.allSettled(promises);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/status') {
    return json(res, statuses);
  }

  if (url.pathname === '/tools') {
    const all = [];
    for (const [serverName, tools] of Object.entries(toolsCache)) {
      for (const t of tools) all.push({ serverName, ...t });
    }
    return json(res, all);
  }

  if (url.pathname === '/reconnect') {
    const agentName = url.searchParams.get('agent') || undefined;
    await loadAndConnect(agentName);
    return json(res, { ok: true });
  }

  if (url.pathname === '/execute' && req.method === 'POST') {
    try {
      const { serverName, toolName, args } = await bodyJson(req);
      const entry = clients.get(serverName);
      if (!entry) return json(res, { error: `Server "${serverName}" not connected` }, 400);
      const result = await entry.client.callTool({ name: toolName, arguments: args });
      return json(res, result);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  json(res, { error: 'Not found' }, 404);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.error(`[MCP bridge] Listening on port ${port}`);
  // Tell parent process which port we got
  if (process.send) process.send({ port });
});

// Initial load
loadAndConnect(undefined);
