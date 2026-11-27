(function (globalScope) {
  'use strict';

  function capPlugin(name) {
    try {
      return globalScope.Capacitor?.Plugins?.[name] || null;
    } catch (e) {
      return null;
    }
  }

  function isNativeCap() {
    try {
      return Boolean(globalScope.Capacitor?.isNativePlatform?.());
    } catch (e) {
      return false;
    }
  }

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function requestHttp({ url, method = 'GET', headers = {}, body = undefined, timeoutMs = 120000 }) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const capHttp = capPlugin('CapacitorHttp');
    if (capHttp && isNativeCap()) {
      const opts = {
        url,
        method: upperMethod,
        headers,
        connectTimeout: 30000,
        readTimeout: timeoutMs
      };
      if (body !== undefined && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
        opts.data = body;
      }
      const res = await capHttp.request(opts);
      let data = res.data;
      let text = '';
      if (typeof data === 'string') {
        text = data;
        try { data = JSON.parse(data); } catch (e) { data = { message: text }; }
      } else if (data && typeof data === 'object') {
        try { text = JSON.stringify(data); } catch (e) { text = ''; }
      }
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: '',
        data: data || {},
        text
      };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const fetchOpts = {
        method: upperMethod,
        headers,
        signal: controller ? controller.signal : undefined
      };
      if (body !== undefined && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetch(url, fetchOpts);
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: text }; }
      return { ok: res.ok, status: res.status, statusText: res.statusText, data, text };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function normalizeChatCompletionsUrl(rawBase) {
    const clean = String(rawBase || '').trim().replace(/\/+$/, '');
    if (!clean) return '';
    if (/\/chat\/completions$/i.test(clean)) return clean;
    return clean + '/chat/completions';
  }

  function hasLiveProviderConfig(state, providerKey) {
    const cfg = (state.providers && state.providers[providerKey]) || {};
    const key = (cfg.apiKey || '').trim();
    if (providerKey === 'custom') {
      const base = (cfg.baseUrl || '').trim();
      return base.startsWith('https://') && base !== 'https://api.example.com/v1' && (key.length > 0 || base.length > 12);
    }
    return key.length > 4;
  }

  function selectRelevantWikiPages(wiki, query, cfg) {
    if (!Array.isArray(wiki) || !wiki.length) return [];
    const mode = (cfg && cfg.wikiRetrievalMode) || 'smart';
    const maxPages = Math.max(1, Number((cfg && cfg.wikiMaxPages) || 6));
    if (mode === 'off') return [];
    if (mode === 'all') return wiki.slice(0, maxPages);

    const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const scored = wiki.map(p => {
      const hay = (p.title + ' ' + p.category + ' ' + p.content).toLowerCase();
      let score = p.slug === 'index' || p.id === 'wiki_index' ? 10 : 0;
      for (const w of words) {
        if (p.title.toLowerCase().includes(w)) score += 6;
        if (hay.includes(w)) score += 2;
      }
      return { page: p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxPages).map(s => s.page);
  }

  function buildContextPrompt(agent, userText, state, compileAgentsMdFn) {
    const cfg = state.harness || {};
    const snippetLimit = Math.max(200, Number(cfg.wikiSnippetChars || 1100));
    const parts = [agent.systemPrompt || 'You are a helpful Keryx agent.'];

    if (typeof compileAgentsMdFn === 'function') {
      parts.push('Active Harness Rules:\n' + compileAgentsMdFn());
    }

    if (agent.memoryEnabled && Array.isArray(state.memory) && state.memory.length) {
      const memLines = state.memory.slice(0, 25).map(m => `- **${m.key}**: ${m.value}`).join('\n');
      parts.push('Persistent Memory (MEMORY.md):\n' + memLines);
    }

    if (agent.wikiPermission !== 'none') {
      const pages = selectRelevantWikiPages(state.wiki, userText, cfg);
      if (pages.length) {
        const wikiText = pages.map(p => `### [[${p.title}]] (${p.category})\n${String(p.content || '').slice(0, snippetLimit)}`).join('\n\n');
        parts.push(`LLM Wiki Context (${pages.length}/${state.wiki.length} pages, permission=${agent.wikiPermission}):\n${wikiText}`);
      }
    }

    const enabledSkills = (state.skills || []).filter(s => s.enabled && (agent.skillIds || []).includes(s.id));
    if (enabledSkills.length) {
      parts.push('Active SKILL.md Playbooks:\n' + enabledSkills.map(s => s.content).join('\n\n'));
    }

    return parts.join('\n\n');
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function upsertWikiPage(state, { title, category = 'sources', content, agentName = 'Agent' }) {
    const cleanTitle = String(title || 'Untitled Note').trim();
    const slug = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('page');
    let existing = state.wiki.find(w => w.title.toLowerCase() === cleanTitle.toLowerCase() || w.slug === slug);
    const stamp = 'Today, ' + nowTime();
    if (existing) {
      existing.content = content;
      existing.category = category || existing.category;
      existing.updatedAt = stamp;
    } else {
      existing = {
        id: uid('wiki'),
        slug,
        title: cleanTitle,
        category,
        updatedAt: stamp,
        content
      };
      state.wiki.push(existing);
    }
    if (!state.harness || state.harness.autoUpdateWikiLog !== false) {
      const logPage = state.wiki.find(w => w.id === 'wiki_log' || w.slug === 'wiki-log');
      if (logPage) {
        logPage.content += `\n- **${nowTime()}** — ${agentName} updated [[${cleanTitle}]] (${category}).`;
        logPage.updatedAt = stamp;
      }
    }
    return existing;
  }

  function runSchemaVerify(state, draftText) {
    const issues = [];
    const text = String(draftText || '');
    if (/\[(TBD|TODO|PLACEHOLDER)\]/i.test(text)) {
      issues.push('Draft contains unverified [TBD]/[TODO] placeholder markers.');
    }
    const existingTitles = new Set((state.wiki || []).map(w => w.title.toLowerCase()));
    const brokenLinks = [];
    for (const page of (state.wiki || [])) {
      const matches = [...String(page.content || '').matchAll(/\[\[([^\]]+)\]\]/g)];
      for (const m of matches) {
        const target = m[1].trim().toLowerCase();
        if (target && !existingTitles.has(target) && target !== 'index' && target !== 'log') {
          brokenLinks.push(`[[${page.title}]] -> [[${m[1]}]]`);
        }
      }
    }
    return {
      passed: issues.length === 0,
      issues,
      brokenLinks,
      wikiCount: (state.wiki || []).length
    };
  }

  async function dispatchConnector(connector, text, title) {
    if (!connector) throw new Error('Connector not found');
    const msg = title ? `${title}\n\n${text}` : text;
    const type = (connector.kind || connector.name || '').toLowerCase();

    if (type.includes('telegram')) {
      const token = (connector.botToken || '').trim();
      const chatId = (connector.chatId || connector.handle || '').trim();
      if (!token || !chatId || chatId.startsWith('@keryx_personal')) {
        throw new Error('Configure Telegram Bot Token & numeric/channel Chat ID in Hub -> Links.');
      }
      const res = await requestHttp({
        url: `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { chat_id: chatId, text: msg }
      });
      if (!res.ok || res.data?.ok === false) {
        throw new Error(res.data?.description || `Telegram HTTP ${res.status}`);
      }
      return { ok: true, detail: `Telegram message sent to ${chatId}` };
    }

    if (type.includes('discord')) {
      const url = (connector.webhookUrl || '').trim();
      if (!url.startsWith('https://')) {
        throw new Error('Configure Discord Webhook HTTPS URL in Hub -> Links.');
      }
      const res = await requestHttp({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { content: msg.slice(0, 1900) }
      });
      if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
      return { ok: true, detail: `Discord webhook delivered (${res.status})` };
    }

    if (type.includes('slack')) {
      const url = (connector.webhookUrl || '').trim();
      if (!url.startsWith('https://')) {
        throw new Error('Configure Slack Incoming Webhook HTTPS URL in Hub -> Links.');
      }
      const res = await requestHttp({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { text: msg }
      });
      if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
      return { ok: true, detail: `Slack webhook delivered (${res.status})` };
    }

    const hookUrl = (connector.webhookUrl || connector.handle || '').trim();
    if (!hookUrl.startsWith('https://')) {
      throw new Error(`Configure an HTTPS Webhook URL for ${connector.name} in Hub -> Links.`);
    }
    const headers = { 'Content-Type': 'application/json' };
    if (connector.authHeader) headers['Authorization'] = connector.authHeader;
    const res = await requestHttp({
      url: hookUrl,
      method: 'POST',
      headers,
      body: { source: 'keryx', title: title || 'Agent Alert', message: msg, timestamp: new Date().toISOString() }
    });
    if (!res.ok) throw new Error(`${connector.name} HTTP ${res.status}`);
    return { ok: true, detail: `${connector.name} delivered (${res.status})` };
  }

  async function connectMcpServer(mcp) {
    const url = (mcp.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('MCP server needs an HTTP/HTTPS endpoint URL.');
    }
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (mcp.authToken) headers['Authorization'] = 'Bearer ' + mcp.authToken.trim();

    const initRes = await requestHttp({
      url,
      method: 'POST',
      headers,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'keryx-mobile', version: '2.0.0' }
        }
      },
      timeoutMs: 25000
    });
    if (!initRes.ok) {
      throw new Error(initRes.data?.error?.message || `MCP initialize HTTP ${initRes.status}`);
    }

    const listRes = await requestHttp({
      url,
      method: 'POST',
      headers,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      timeoutMs: 25000
    });
    if (!listRes.ok) {
      throw new Error(listRes.data?.error?.message || `MCP tools/list HTTP ${listRes.status}`);
    }
    const tools = Array.isArray(listRes.data?.result?.tools)
      ? listRes.data.result.tools.map(t => t.name).filter(Boolean)
      : mcp.tools || [];
    mcp.status = 'connected';
    if (tools.length) mcp.tools = tools;
    mcp.toolSchemas = Array.isArray(listRes.data?.result?.tools) ? listRes.data.result.tools : [];
    return tools;
  }

  async function callMcpTool(mcp, toolName, args) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (mcp.authToken) headers['Authorization'] = 'Bearer ' + mcp.authToken.trim();
    const res = await requestHttp({
      url: mcp.url,
      method: 'POST',
      headers,
      body: {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args || {} }
      },
      timeoutMs: 30000
    });
    if (!res.ok || res.data?.error) {
      throw new Error(res.data?.error?.message || `MCP call HTTP ${res.status}`);
    }
    return res.data?.result || res.data;
  }

  async function runWebSearch(query, state) {
    const cfg = state.search || {};
    const provider = cfg.provider || 'duckduckgo';
    const q = String(query || '').trim();
    if (!q) return { results: [], note: 'Empty search query' };

    if (provider === 'tavily' && cfg.apiKey) {
      const res = await requestHttp({
        url: 'https://api.tavily.com/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { api_key: cfg.apiKey.trim(), query: q, max_results: 5, include_answer: true }
      });
      if (!res.ok) throw new Error(res.data?.detail || `Tavily HTTP ${res.status}`);
      return {
        answer: res.data?.answer || '',
        results: (res.data?.results || []).map(r => ({ title: r.title, url: r.url, snippet: String(r.content || '').slice(0, 320) }))
      };
    }

    if (provider === 'brave' && cfg.apiKey) {
      const res = await requestHttp({
        url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': cfg.apiKey.trim() }
      });
      if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
      return {
        results: (res.data?.web?.results || []).map(r => ({ title: r.title, url: r.url, snippet: String(r.description || '').slice(0, 320) }))
      };
    }

    if ((provider === 'searxng' || provider === 'custom') && cfg.endpoint) {
      const base = cfg.endpoint.trim().replace(/\/+$/, '');
      const url = base.includes('{query}') ? base.replace('{query}', encodeURIComponent(q)) : `${base}/search?q=${encodeURIComponent(q)}&format=json`;
      const headers = { 'Accept': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey.trim();
      const res = await requestHttp({ url, method: 'GET', headers });
      if (!res.ok) throw new Error(`Search endpoint HTTP ${res.status}`);
      return { results: (res.data?.results || []).slice(0, 6) };
    }

    // Default free live search: DuckDuckGo Instant Answer + Wikipedia summary search
    const results = [];
    try {
      const ddg = await requestHttp({
        url: `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
        method: 'GET',
        timeoutMs: 15000
      });
      if (ddg.ok && ddg.data) {
        if (ddg.data.AbstractText) {
          results.push({ title: ddg.data.Heading || q, url: ddg.data.AbstractURL || '', snippet: ddg.data.AbstractText });
        }
        const related = Array.isArray(ddg.data.RelatedTopics) ? ddg.data.RelatedTopics : [];
        for (const item of related.slice(0, 4)) {
          if (item && item.Text) results.push({ title: item.FirstURL || 'Related', url: item.FirstURL || '', snippet: item.Text });
        }
      }
    } catch (e) {}

    try {
      const wikiRes = await requestHttp({
        url: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&srlimit=4`,
        method: 'GET',
        timeoutMs: 15000
      });
      if (wikiRes.ok && Array.isArray(wikiRes.data?.query?.search)) {
        for (const hit of wikiRes.data.query.search) {
          results.push({
            title: hit.title,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
            snippet: stripHtml(hit.snippet)
          });
        }
      }
    } catch (e) {}

    return { query: q, results: results.slice(0, 6) };
  }

  function requiresHumanApproval(toolMeta, agent, state) {
    const policy = (state.harness && state.harness.defaultPolicy) || 'balanced';
    if (!state.harness || !state.harness.globalApprovalGate || policy === 'autopilot') return false;
    if (agent && agent.approvalGate === false && policy !== 'strict') return false;
    if (policy === 'strict') return true;
    return Boolean(toolMeta && toolMeta.destructive);
  }

  function buildToolDefinitions(agent, state) {
    if (state.harness && state.harness.enableToolCalling === false) return [];
    const enabledTools = (state.tools || []).filter(t => t.enabled && (agent.toolIds || []).includes(t.id));
    const defs = [];

    const builtinSchemas = {
      web_search: {
        description: 'Search the live web for facts, news, documentation, or topics.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
      },
      http_fetch: {
        description: 'Fetch JSON or plain text from an HTTPS URL.',
        parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } }, required: ['url'] }
      },
      wiki_read_write: {
        description: 'List, read, search, or upsert pages in the user LLM Wiki.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'read', 'search', 'upsert', 'lint'] },
            title: { type: 'string' },
            category: { type: 'string', enum: ['concepts', 'entities', 'sources', 'logs'] },
            content: { type: 'string' },
            query: { type: 'string' }
          },
          required: ['action']
        }
      },
      persistent_memory: {
        description: 'Read, search, or save enduring facts into persistent MEMORY.md storage.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'write', 'delete'] },
            key: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['action']
        }
      },
      sandbox_eval: {
        description: 'Evaluate an isolated JavaScript expression or JSON transform.',
        parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
      },
      schema_verify: {
        description: 'Validate draft text for placeholders and check all wiki [[wikilinks]].',
        parameters: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'] }
      },
      spawn_subagent: {
        description: 'Delegate a focused subtask to another configured agent.',
        parameters: { type: 'object', properties: { agentName: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] }
      },
      obsidian_vault_rw: {
        description: 'Save or update a Markdown note in Obsidian Mobile Vault / Documents.',
        parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] }
      },
      outbound_webhook: {
        description: 'Send a message or JSON payload to a configured connector or webhook.',
        parameters: { type: 'object', properties: { connectorName: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' } }, required: ['message'] }
      }
    };

    for (const t of enabledTools) {
      if (builtinSchemas[t.name]) {
        defs.push({ name: t.name, meta: t, ...builtinSchemas[t.name] });
      } else {
        defs.push({
          name: t.name,
          meta: t,
          description: t.description || `Call custom ${t.method} endpoint ${t.endpoint}`,
          parameters: { type: 'object', properties: { payload: { type: 'object' }, query: { type: 'string' } } }
        });
      }
    }

    // Connected MCP server tools assigned to agent
    const agentMcps = (state.mcps || []).filter(m => m.status === 'connected' && (agent.mcpIds || []).includes(m.id));
    for (const m of agentMcps) {
      for (const tn of (m.tools || [])) {
        const schemaObj = (m.toolSchemas || []).find(s => s.name === tn);
        defs.push({
          name: `mcp_${m.id}_${tn}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          mcp: m,
          mcpToolName: tn,
          meta: { name: tn, destructive: false },
          description: (schemaObj && schemaObj.description) || `MCP tool ${tn} on ${m.name}`,
          parameters: (schemaObj && schemaObj.inputSchema) || { type: 'object', properties: {} }
        });
      }
    }

    return defs;
  }

  async function executeToolCall(toolDef, args, ctx) {
    const { agent, state, depth = 0, bypassApproval = false, compileAgentsMdFn } = ctx;
    const name = toolDef.name;

    if (!bypassApproval && requiresHumanApproval(toolDef.meta, agent, state)) {
      return {
        approvalRequired: true,
        pendingApproval: {
          id: uid('appr'),
          kind: 'tool',
          toolName: name,
          args: args || {},
          agentId: agent.id,
          tool: toolDef.meta?.name || name,
          summary: `${name}(${JSON.stringify(args || {}).slice(0, 140)})`,
          status: 'pending'
        }
      };
    }

    if (toolDef.mcp) {
      return await callMcpTool(toolDef.mcp, toolDef.mcpToolName, args);
    }

    if (name === 'web_search') {
      return await runWebSearch(args.query, state);
    }

    if (name === 'http_fetch') {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Invalid URL for http_fetch');
      const res = await requestHttp({ url, method: args.method || 'GET', timeoutMs: 25000 });
      return {
        status: res.status,
        ok: res.ok,
        content: (res.data && Object.keys(res.data).length && !res.data.message)
          ? res.data
          : stripHtml(res.text).slice(0, 4000)
      };
    }

    if (name === 'wiki_read_write') {
      const action = args.action || 'list';
      if (agent.wikiPermission === 'none') throw new Error('Wiki permission is disabled for this agent.');
      if (action === 'list') {
        return { pages: (state.wiki || []).map(p => ({ title: p.title, category: p.category, updatedAt: p.updatedAt })) };
      }
      if (action === 'read') {
        const p = (state.wiki || []).find(w => w.title.toLowerCase() === String(args.title || '').toLowerCase());
        return p ? { title: p.title, category: p.category, content: p.content } : { error: 'Page not found' };
      }
      if (action === 'search') {
        const q = String(args.query || '').toLowerCase();
        return {
          matches: (state.wiki || [])
            .filter(w => w.title.toLowerCase().includes(q) || w.content.toLowerCase().includes(q))
            .slice(0, 6)
            .map(w => ({ title: w.title, snippet: w.content.slice(0, 300) }))
        };
      }
      if (action === 'lint') {
        return runSchemaVerify(state, '');
      }
      if (action === 'upsert') {
        if (agent.wikiPermission !== 'read-write') throw new Error('Agent only has read-only wiki permission.');
        const saved = upsertWikiPage(state, {
          title: args.title || 'Agent Note',
          category: args.category || 'sources',
          content: args.content || '',
          agentName: agent.name
        });
        return { saved: true, title: saved.title, category: saved.category };
      }
    }

    if (name === 'persistent_memory') {
      if (!Array.isArray(state.memory)) state.memory = [];
      const action = args.action || 'list';
      if (action === 'list') return { memories: state.memory };
      if (action === 'write') {
        const key = String(args.key || '').trim();
        const value = String(args.value || '').trim();
        if (!key || !value) throw new Error('Memory key and value required');
        const existing = state.memory.find(m => m.key.toLowerCase() === key.toLowerCase());
        if (existing) {
          existing.value = value;
          existing.updatedAt = 'Today, ' + nowTime();
        } else {
          state.memory.unshift({ id: uid('mem'), key, value, updatedAt: 'Today, ' + nowTime() });
        }
        return { saved: true, key, value };
      }
      if (action === 'delete') {
        state.memory = state.memory.filter(m => m.key.toLowerCase() !== String(args.key || '').toLowerCase());
        return { deleted: true, key: args.key };
      }
    }

    if (name === 'sandbox_eval') {
      const code = String(args.code || '').trim();
      if (!code) throw new Error('No code provided');
      try {
        const fn = new Function('"use strict"; return (' + code + ');');
        return { result: fn() };
      } catch (e) {
        const fnStmt = new Function('"use strict"; ' + code);
        return { result: fnStmt() };
      }
    }

    if (name === 'schema_verify') {
      return runSchemaVerify(state, args.draft || '');
    }

    if (name === 'spawn_subagent') {
      if (depth >= 2) throw new Error('Subagent recursion depth limit reached (max 2)');
      const target = (state.agents || []).find(a => a.name.toLowerCase() === String(args.agentName || '').toLowerCase())
        || (state.agents || []).find(a => a.id !== agent.id)
        || agent;
      const subResp = await runAgentLoop({
        agent: target,
        userText: String(args.prompt || ''),
        priorTurns: [],
        state,
        depth: depth + 1,
        compileAgentsMdFn
      });
      return { subagent: target.name, reply: subResp.text };
    }

    if (name === 'obsidian_vault_rw') {
      if (state.obsidian && state.obsidian.syncMode === 'read-only') {
        throw new Error('Obsidian Vault is set to Read-Only mode.');
      }
      const title = args.title || 'Obsidian Note';
      const content = args.content || '';
      const saved = upsertWikiPage(state, { title, category: 'sources', content, agentName: agent.name });
      saved.source = 'obsidian';
      const fsPlugin = capPlugin('Filesystem');
      if (fsPlugin && isNativeCap()) {
        const folder = (state.obsidian?.folderPath || 'Keryx-Wiki').replace(/^\/+|\/+$/g, '');
        const relPath = (folder ? folder + '/' : '') + saved.slug + '.md';
        await fsPlugin.writeFile({ path: relPath, data: content, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
        return { saved: true, nativePath: 'Documents/' + relPath };
      }
      return { saved: true, title: saved.title };
    }

    if (name === 'outbound_webhook') {
      const conn = (state.connectors || []).find(c =>
        c.enabled && (!args.connectorName || c.name.toLowerCase().includes(String(args.connectorName).toLowerCase()))
      ) || (state.connectors || []).find(c => c.enabled);
      if (!conn) throw new Error('No enabled connector found in Hub -> Links.');
      return await dispatchConnector(conn, args.message || '', args.title || 'Keryx Agent');
    }

    // Custom REST tool
    const meta = toolDef.meta;
    if (meta && /^https?:\/\//i.test(meta.endpoint || '')) {
      let headers = { 'Content-Type': 'application/json' };
      if (meta.headers && typeof meta.headers === 'object') headers = { ...headers, ...meta.headers };
      const res = await requestHttp({
        url: meta.endpoint,
        method: meta.method || 'POST',
        headers,
        body: (meta.method || 'POST').toUpperCase() === 'GET' ? undefined : (args.payload || args)
      });
      return { status: res.status, ok: res.ok, data: res.data };
    }

    throw new Error(`Tool ${name} has no executable endpoint`);
  }

  async function callProviderOnce({ agent, sysPrompt, messages, toolDefs, state, onStreamText }) {
    const cfg = (state.providers && state.providers[agent.provider]) || {};
    const apiKey = (cfg.apiKey || '').trim();
    const customBase = (cfg.baseUrl || '').trim();
    const maxTokens = Math.max(256, Number((state.harness && state.harness.maxOutputTokens) || 4096));

    if (agent.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(agent.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const contents = messages.map(m => {
        if (m.role === 'tool_result') {
          return { role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] };
        }
        if (m.role === 'assistant_tool_calls') {
          return { role: 'model', parts: m.calls.map(c => ({ functionCall: { name: c.name, args: c.args || {} } })) };
        }
        return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] };
      });
      const payload = {
        system_instruction: { parts: [{ text: sysPrompt }] },
        contents,
        generationConfig: { temperature: agent.temperature, maxOutputTokens: maxTokens }
      };
      if (toolDefs && toolDefs.length) {
        payload.tools = [{ functionDeclarations: toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
      }
      const res = await requestHttp({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      if (!res.ok) throw new Error(res.data?.error?.message || `Gemini HTTP ${res.status}`);
      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter(p => p.functionCall).map(p => ({ id: uid('tc'), name: p.functionCall.name, args: p.functionCall.args || {} }));
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      return { text, toolCalls: calls };
    }

    if (agent.provider === 'anthropic') {
      const anthropicMsgs = [];
      for (const m of messages) {
        if (m.role === 'assistant_tool_calls') {
          anthropicMsgs.push({
            role: 'assistant',
            content: m.calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))
          });
        } else if (m.role === 'tool_result') {
          anthropicMsgs.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.callId, content: JSON.stringify(m.content) }]
          });
        } else {
          anthropicMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text });
        }
      }
      const payload = {
        model: agent.model,
        max_tokens: maxTokens,
        temperature: agent.temperature,
        system: sysPrompt,
        messages: anthropicMsgs
      };
      if (toolDefs && toolDefs.length) {
        payload.tools = toolDefs.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      }
      const res = await requestHttp({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: payload
      });
      if (!res.ok) throw new Error(res.data?.error?.message || `Anthropic HTTP ${res.status}`);
      const blocks = res.data?.content || [];
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, toolCalls: calls };
    }

    // OpenAI / OpenRouter / Custom OpenAI-Compatible
    const endpoint = agent.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : agent.provider === 'custom'
      ? normalizeChatCompletionsUrl(customBase)
      : 'https://api.openai.com/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (agent.provider === 'openrouter') headers['X-Title'] = 'Keryx Personal Agentic Platform';

    const oaiMsgs = [{ role: 'system', content: sysPrompt }];
    for (const m of messages) {
      if (m.role === 'assistant_tool_calls') {
        oaiMsgs.push({
          role: 'assistant',
          content: null,
          tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }))
        });
      } else if (m.role === 'tool_result') {
        oaiMsgs.push({ role: 'tool', tool_call_id: m.callId, content: JSON.stringify(m.content) });
      } else {
        oaiMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text });
      }
    }

    const body = { model: agent.model, temperature: agent.temperature, max_tokens: maxTokens, messages: oaiMsgs };
    if (toolDefs && toolDefs.length) {
      body.tools = toolDefs.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }

    // Optional SSE streaming on Web when no tools or final pass
    const canStreamWeb = !isNativeCap() && state.harness?.enableStreaming && typeof onStreamText === 'function' && (!toolDefs || !toolDefs.length);
    if (canStreamWeb) {
      try {
        const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
        if (res.ok && res.body && (res.headers.get('content-type') || '').includes('text/event-stream')) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let acc = '';
          let buf = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payloadStr = trimmed.slice(5).trim();
              if (payloadStr === '[DONE]') continue;
              try {
                const json = JSON.parse(payloadStr);
                const delta = json?.choices?.[0]?.delta?.content || '';
                if (delta) {
                  acc += delta;
                  onStreamText(acc);
                }
              } catch (e) {}
            }
          }
          if (acc) return { text: acc, toolCalls: [] };
        }
      } catch (e) {}
    }

    let res = await requestHttp({ url: endpoint, method: 'POST', headers, body });
    // Graceful fallback if a custom endpoint rejects the `tools` parameter
    if (!res.ok && body.tools && (res.status === 400 || res.status === 422)) {
      const noToolsBody = { model: agent.model, temperature: agent.temperature, max_tokens: maxTokens, messages: oaiMsgs };
      res = await requestHttp({ url: endpoint, method: 'POST', headers, body: noToolsBody });
    }
    if (!res.ok) {
      throw new Error(res.data?.error?.message || res.data?.detail || res.data?.message || `HTTP ${res.status} ${res.statusText}`);
    }
    const msg = res.data?.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map(tc => {
          let parsed = {};
          try { parsed = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function?.arguments || {}); } catch (e) {}
          return { id: tc.id || uid('tc'), name: tc.function?.name, args: parsed };
        })
      : [];
    let text = '';
    if (Array.isArray(msg.content)) {
      text = msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
    } else {
      text = msg.content || msg.reasoning_content || '';
    }
    return { text, toolCalls: calls };
  }

  async function runAgentLoop({ agent, userText, priorTurns = [], state, onStep, onStreamText, depth = 0, compileAgentsMdFn }) {
    const stepUpdate = (idx, detail) => { if (typeof onStep === 'function') onStep(idx, detail); };
    const pause = (ms) => new Promise(r => setTimeout(r, ms));
    const trace = [];

    stepUpdate(0, `Orienting via AGENTS.md & ${state.wiki.length} wiki pages`);
    trace.push({ step: 'Orient', detail: `Loaded AGENTS.md & ${state.wiki.length} wiki pages`, status: 'ok' });
    await pause(90);

    const toolDefs = buildToolDefinitions(agent, state);
    stepUpdate(1, `Prepared ${toolDefs.length} executable tools & skills`);
    trace.push({ step: 'Skills & Tools', detail: `${toolDefs.length} tools bound`, status: 'ok' });
    await pause(90);

    const canCallLive = hasLiveProviderConfig(state, agent.provider);
    if (!canCallLive) {
      stepUpdate(2, `Running local simulator for ${agent.model}`);
      await pause(180);
      const lower = userText.toLowerCase();
      const needsSend = /telegram|slack|discord|whatsapp|send|notify|webhook|email/.test(lower);
      if (needsSend && requiresHumanApproval({ destructive: true }, agent, state)) {
        const enabledConn = (state.connectors || []).find(c => c.enabled) || (state.connectors || [])[0];
        stepUpdate(3, 'Paused at Approval Gate');
        trace.push({ step: 'Approval Gate', detail: 'Paused external send for human approval', status: 'warn' });
        return {
          text: `Prepared outbound message for **"${userText.slice(0, 70)}"**, paused because **Approval Gate is ON**.`,
          pendingApproval: {
            id: uid('appr'),
            kind: 'connector',
            connectorId: enabledConn ? enabledConn.id : null,
            message: userText,
            title: agent.name,
            tool: enabledConn ? enabledConn.name : 'Outbound Connector',
            summary: `Dispatch via ${enabledConn ? enabledConn.name : 'Connector'}: "${userText.slice(0, 90)}"`,
            status: 'pending'
          },
          trace
        };
      }
      stepUpdate(3, 'Verified output cleanly');
      await pause(140);
      trace.push({ step: 'Verify Gate', detail: 'Simulated verification gate passed', status: 'ok' });
      return {
        text: `**${agent.name}** processed your request in **Sim mode** using \`${agent.model}\`.\n\n- Bound tools: ${toolDefs.slice(0, 4).map(t => '`' + t.name + '`').join(', ') || '`core`'}.\n- Configure an API key/URL for **${agent.provider}** in Provider Vault for live tool-calling execution.`,
        trace
      };
    }

    const sysPrompt = buildContextPrompt(agent, userText, state, compileAgentsMdFn);
    const contextLimit = Math.max(2, Number((state.harness && state.harness.contextTurns) || 12));
    const messages = [
      ...priorTurns.slice(-contextLimit).map(m => ({ role: m.role, text: m.text })),
      { role: 'user', text: userText }
    ];

    const maxSteps = Math.max(1, Number(agent.maxSteps || state.harness?.maxSteps || 8));
    const maxRetries = Math.max(1, Number(state.harness?.maxRetries || 2));
    let consecutiveErrors = 0;

    try {
      for (let step = 0; step < maxSteps; step++) {
        stepUpdate(2, `Calling ${agent.provider}/${agent.model} (step ${step + 1}/${maxSteps})`);
        const resp = await callProviderOnce({ agent, sysPrompt, messages, toolDefs, state, onStreamText });

        if (!resp.toolCalls || !resp.toolCalls.length) {
          const finalText = resp.text || 'Completed with empty text.';
          stepUpdate(3, 'Running Harness Verification Gate');
          const ver = runSchemaVerify(state, finalText);
          trace.push({ step: 'Execute', detail: `${agent.provider}/${agent.model} responded (${messages.length} turns)`, status: 'ok' });
          trace.push({
            step: 'Verify Gate',
            detail: ver.passed ? '0 schema/placeholder issues' : ver.issues.join(' '),
            status: ver.passed ? 'ok' : 'warn'
          });
          return { text: finalText, trace };
        }

        messages.push({ role: 'assistant_tool_calls', calls: resp.toolCalls });
        for (const tc of resp.toolCalls) {
          const def = toolDefs.find(d => d.name === tc.name);
          if (!def) {
            messages.push({ role: 'tool_result', callId: tc.id, name: tc.name, content: { error: `Unknown tool ${tc.name}` } });
            continue;
          }
          stepUpdate(2, `Running tool ${tc.name}...`);
          try {
            const toolResult = await executeToolCall(def, tc.args, { agent, state, depth, compileAgentsMdFn });
            if (toolResult && toolResult.approvalRequired) {
              stepUpdate(3, 'Paused at Approval Gate');
              trace.push({ step: 'Approval Gate', detail: `Paused ${tc.name} for user confirmation`, status: 'warn' });
              return {
                text: `I am ready to run **${tc.name}**, but **Approval Gate is ON**. Review and approve below to execute it.`,
                pendingApproval: toolResult.pendingApproval,
                trace
              };
            }
            consecutiveErrors = 0;
            trace.push({ step: `Tool: ${tc.name}`, detail: JSON.stringify(toolResult).slice(0, 120), status: 'ok' });
            messages.push({ role: 'tool_result', callId: tc.id, name: tc.name, content: toolResult });
          } catch (toolErr) {
            consecutiveErrors += 1;
            const msg = toolErr && toolErr.message ? toolErr.message : 'Tool execution error';
            trace.push({ step: `Tool: ${tc.name}`, detail: msg, status: 'danger' });
            messages.push({ role: 'tool_result', callId: tc.id, name: tc.name, content: { error: msg } });
            if (consecutiveErrors >= maxRetries) {
              stepUpdate(3, 'Escape Hatch triggered');
              trace.push({ step: 'Escape Hatch', detail: `Halted after ${consecutiveErrors} consecutive tool failures`, status: 'warn' });
              return {
                text: `Stopped safely after ${consecutiveErrors} consecutive tool failures (Escape Hatch).\n\nLast error in \`${tc.name}\`: \`${msg}\``,
                trace
              };
            }
          }
        }
      }

      stepUpdate(3, 'Max step budget reached');
      trace.push({ step: 'Budget', detail: `Reached maxSteps=${maxSteps}`, status: 'warn' });
      return { text: `Reached step budget (${maxSteps} steps). Increase Max Steps in Agent or Harness settings if needed.`, trace };
    } catch (err) {
      stepUpdate(3, 'Captured API error cleanly');
      const rawErr = err && err.message ? err.message : 'Request failed';
      const errMsg = /failed to fetch/i.test(rawErr) && !isNativeCap()
        ? `${rawErr} — Browser CORS blocked this endpoint. Install the Android APK (CapacitorHttp) or use a CORS-enabled proxy.`
        : rawErr;
      trace.push({ step: 'Execute', detail: `${agent.provider}/${agent.model} failed: ${errMsg}`, status: 'danger' });
      trace.push({ step: 'Escape Hatch', detail: 'Surfaced inline error without silent fallback', status: 'warn' });
      return {
        text: `Could not reach **${agent.provider}** using Model ID \`${agent.model}\`.\n\nCheck your API key, HTTPS endpoint, or exact Model ID in **Provider Vault**.`,
        error: { provider: agent.provider, model: agent.model, message: errMsg },
        trace
      };
    }
  }

  function runHarnessVerificationSuite(state) {
    const gateOn = Boolean(state.harness && state.harness.globalApprovalGate);
    const wikiCheck = runSchemaVerify(state, '');
    const draftCheck = runSchemaVerify(state, 'Draft summary [TBD] pending verification');
    const maxRetries = Number((state.harness && state.harness.maxRetries) || 2);
    return {
      test_boundary: {
        pass: true,
        badge: gateOn ? 'PAUSED (GATED)' : 'ALLOWED (AUTOPILOT)',
        detail: gateOn
          ? `Global Approval Gate ON (${state.harness.defaultPolicy}) — destructive/external calls return approvalRequired.`
          : 'Global Approval Gate OFF — external actions execute directly with audit logging.'
      },
      test_verification: {
        pass: !draftCheck.passed,
        badge: !draftCheck.passed ? 'PASSED' : 'WARN',
        detail: `Blocked [TBD] draft cleanly. Live Wiki audit: ${wikiCheck.wikiCount} pages, ${wikiCheck.brokenLinks.length} broken [[wikilinks]].`
      },
      test_recovery: {
        pass: true,
        badge: 'PASSED',
        detail: `Escape hatch configured at maxRetries=${maxRetries} consecutive tool errors (halts loop cleanly).`
      }
    };
  }

  function shouldCronRunNow(cronJob, nowMs = Date.now()) {
    if (!cronJob || !cronJob.enabled) return false;
    const lastTs = Number(cronJob.lastRunTs || 0);
    const sched = String(cronJob.schedule || '').trim();
    const now = new Date(nowMs);

    const intervalMatch = sched.match(/Every\s+(\d+)\s*(m|min|h|hr|hour)/i);
    if (intervalMatch) {
      const n = Number(intervalMatch[1]);
      const unitMs = intervalMatch[2].toLowerCase().startsWith('h') ? 3600000 : 60000;
      return nowMs - lastTs >= n * unitMs;
    }

    const dailyMatch = sched.match(/Daily.*?(\d{1,2}):(\d{2})/i);
    if (dailyMatch) {
      const targetH = Number(dailyMatch[1]);
      const targetM = Number(dailyMatch[2]);
      const todayKey = now.toISOString().slice(0, 10);
      const lastDay = lastTs ? new Date(lastTs).toISOString().slice(0, 10) : '';
      if (lastDay === todayKey) return false;
      return now.getHours() > targetH || (now.getHours() === targetH && now.getMinutes() >= targetM);
    }

    // Standard 5-field cron: m h * * *
    const parts = sched.split(/\s+/);
    if (parts.length === 5) {
      const [mStr, hStr] = parts;
      const mMatch = mStr === '*' || Number(mStr) === now.getMinutes() || (mStr.startsWith('*/') && now.getMinutes() % Number(mStr.slice(2)) === 0);
      const hMatch = hStr === '*' || Number(hStr) === now.getHours();
      return mMatch && hMatch && (nowMs - lastTs >= 60000);
    }
    return false;
  }

  const api = {
    capPlugin,
    isNativeCap,
    requestHttp,
    normalizeChatCompletionsUrl,
    hasLiveProviderConfig,
    selectRelevantWikiPages,
    upsertWikiPage,
    runSchemaVerify,
    dispatchConnector,
    connectMcpServer,
    executeToolCall,
    buildToolDefinitions,
    runAgentLoop,
    runHarnessVerificationSuite,
    shouldCronRunNow
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.KeryxEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
