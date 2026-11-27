import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();

function assert(cond, msg) {
  if (!cond) {
    console.error('VERIFY FAIL:', msg);
    process.exitCode = 1;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert(pkg.dependencies?.['@capacitor/core']?.startsWith('^8.'), 'Expected Capacitor v8 in package.json');
assert(pkg.dependencies?.['@capacitor/android']?.startsWith('^8.'), 'Expected @capacitor/android v8 in package.json');
assert(typeof pkg.scripts?.['build:assets'] === 'string', 'build:assets script defined in package.json');

const capCfg = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
assert(capCfg.appId === 'com.keryx.agentplatform', 'Valid appId in capacitor.config.json');
assert(capCfg.webDir === 'www', 'Valid webDir in capacitor.config.json');
assert(capCfg.plugins?.CapacitorHttp?.enabled === true, 'CapacitorHttp enabled for native CORS bypass');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'www', 'manifest.json'), 'utf8'));
assert(Boolean(manifest.name && manifest.start_url), 'Valid www/manifest.json');

// 1. Offline assets verification
const tailwindCss = path.join(root, 'www', 'vendor', 'tailwind.css');
const lucideJs = path.join(root, 'www', 'vendor', 'lucide.min.js');
assert(fs.existsSync(tailwindCss) && fs.statSync(tailwindCss).size > 2000, 'Offline www/vendor/tailwind.css built');
assert(fs.existsSync(lucideJs) && fs.statSync(lucideJs).size > 50000, 'Offline www/vendor/lucide.min.js present');

// 2. HTML structure & offline bundle verification
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
assert(html.includes('<meta name="color-scheme" content="light dark">'), 'color-scheme meta tag present');
assert(html.includes('<dialog id="app-sheet-dialog"'), 'Native <dialog> sheet element present');
assert(html.includes('./vendor/tailwind.css'), 'Offline Tailwind stylesheet referenced');
assert(html.includes('./vendor/lucide.min.js'), 'Offline Lucide script referenced');
assert(html.includes('./js/storage.js') && html.includes('./js/markdown.js') && html.includes('./js/engine.js'), 'Core JS modules referenced');
assert(!html.includes('cdn.tailwindcss.com') && !html.includes('unpkg.com/lucide'), 'No external Tailwind/Lucide CDNs in index.html');
assert(html.includes('Agent is working…'), 'Live agent processing card present');
assert(html.includes('<details open '), 'Auto-expanded harness trace present');
assert(html.includes('btn-sim-add-key'), 'Sim mode 1-tap Add Key banner present');
assert(!html.includes('sticky bottom-0'), 'Non-overlapping composer without sticky bottom-0');

// Secret scan across web & CI files
const secretTargets = [
  'www/index.html',
  'www/js/storage.js',
  'www/js/markdown.js',
  'www/js/engine.js',
  '.github/workflows/build-android-apk.yml'
];
for (const rel of secretTargets) {
  const txt = fs.readFileSync(path.join(root, rel), 'utf8');
  assert(!/ghp_[A-Za-z0-9]{20,}/.test(txt), `No hardcoded GitHub PAT in ${rel}`);
}

// 3. Syntax check on all JS modules and inline script
const moduleFiles = ['www/js/storage.js', 'www/js/markdown.js', 'www/js/engine.js'];
for (const rel of moduleFiles) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  try {
    new vm.Script(code, { filename: rel });
  } catch (err) {
    assert(false, `JS syntax error in ${rel}: ${err.message}`);
  }
}

const scriptMatches = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)];
const inlineScripts = scriptMatches.filter(m => !/src\s*=/.test(m[0])).map(m => m[1]);
assert(inlineScripts.length > 0, 'Inline application script found');
for (let i = 0; i < inlineScripts.length; i++) {
  try {
    new vm.Script(inlineScripts[i], { filename: `www/index.html#script-${i}` });
  } catch (err) {
    assert(false, `JS syntax error in inline script #${i}: ${err.message}`);
  }
}

// 4. Functional unit tests on KeryxStorage, KeryxMarkdown, KeryxEngine
const KeryxStorage = require(path.join(root, 'www', 'js', 'storage.js'));
const KeryxMarkdown = require(path.join(root, 'www', 'js', 'markdown.js'));
const KeryxEngine = require(path.join(root, 'www', 'js', 'engine.js'));

// Markdown rendering & XSS escaping
const mdRendered = KeryxMarkdown.renderMarkdown(
  '# Title\n\n| Key | Val |\n| --- | --- |\n| A | 1 |\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script> [[Wiki Index]] [Site](https://example.com)'
);
assert(mdRendered.includes('<h2') && mdRendered.includes('<table') && mdRendered.includes('data-copy-code'), 'Markdown headings, tables, and code blocks render');
assert(!mdRendered.includes('<script>alert(1)</script>') && mdRendered.includes('&lt;script&gt;'), 'XSS tags escaped safely in markdown renderer');
assert(mdRendered.includes('data-wikilink="Wiki Index"'), 'Wikilink interactive button rendered');
assert(mdRendered.includes('data-ext-url="https://example.com"'), 'External link button rendered');

// Storage backup redaction & round-trip
const sampleState = {
  ui: { theme: 'paper' },
  providers: { openai: { apiKey: 'sk-test-secret-1234', models: ['gpt-4o'], defaultModel: 'gpt-4o' }, custom: { apiKey: '', baseUrl: 'https://my.proxy.dev/v1' } },
  connectors: [{ id: 'c1', name: 'Telegram', botToken: '123:abc', webhookUrl: '' }],
  search: { provider: 'duckduckgo', apiKey: 'tvly-secret' },
  agents: [{ id: 'ag1', name: 'Research', provider: 'openai', model: 'gpt-4o', wikiPermission: 'read-write', memoryEnabled: true, toolIds: ['t1', 't2', 't3'], approvalGate: true }],
  tools: [
    { id: 't1', name: 'wiki_read_write', enabled: true, destructive: false },
    { id: 't2', name: 'persistent_memory', enabled: true, destructive: false },
    { id: 't3', name: 'outbound_webhook', enabled: true, destructive: true },
    { id: 't4', name: 'sandbox_eval', enabled: true, destructive: false }
  ],
  skills: [],
  mcps: [],
  wiki: [
    { id: 'wiki_index', slug: 'index', title: 'Wiki Index', category: 'logs', content: 'Links to [[Project Plan]]', updatedAt: 'Today' },
    { id: 'w2', slug: 'project-plan', title: 'Project Plan', category: 'concepts', content: 'Details about Keryx architecture', updatedAt: 'Today' }
  ],
  memory: [],
  harness: { defaultPolicy: 'balanced', globalApprovalGate: true, maxSteps: 12, maxRetries: 2, wikiRetrievalMode: 'smart', wikiMaxPages: 4 }
};

const redactedJson = KeryxStorage.exportBackupJson(sampleState, false);
assert(!redactedJson.includes('sk-test-secret-1234') && redactedJson.includes('***REDACTED***'), 'Backup export redacts API keys by default');
const fullJson = KeryxStorage.exportBackupJson(sampleState, true);
assert(fullJson.includes('sk-test-secret-1234'), 'Backup export includes keys when explicitly requested');
const parsedBackup = KeryxStorage.parseBackupJson(fullJson);
assert(parsedBackup.ui.theme === 'paper' && parsedBackup.agents.length === 1, 'Backup JSON parses cleanly');

// Engine URL normalization, provider check, wiki scoring, schema verification, cron, harness suite
assert(KeryxEngine.normalizeChatCompletionsUrl('https://integrate.api.nvidia.com/v1/') === 'https://integrate.api.nvidia.com/v1/chat/completions', 'Custom OpenAI baseUrl normalizes cleanly');
assert(KeryxEngine.hasLiveProviderConfig(sampleState, 'openai') === true, 'Detects valid OpenAI key');
assert(KeryxEngine.hasLiveProviderConfig(sampleState, 'custom') === true, 'Detects custom HTTPS endpoint');

const pickedWiki = KeryxEngine.selectRelevantWikiPages(sampleState.wiki, 'Tell me about Keryx architecture', { wikiRetrievalMode: 'smart', wikiMaxPages: 2 });
assert(pickedWiki.length === 2, 'Smart wiki retrieval selects pages');

const cleanSchema = KeryxEngine.runSchemaVerify(sampleState, 'Valid response referencing [[Project Plan]].');
assert(cleanSchema.passed === true && cleanSchema.brokenLinks.length === 0, 'Schema verify passes clean text & valid wikilinks');
sampleState.wiki.push({ id: 'w3', slug: 'broken', title: 'Broken', category: 'logs', content: 'Points to [[Missing Page]]', updatedAt: 'Today' });
const brokenSchema = KeryxEngine.runSchemaVerify(sampleState, 'Draft with [TBD]');
assert(brokenSchema.passed === false && brokenSchema.issues.length === 1 && brokenSchema.brokenLinks.some(l => l.includes('Missing Page')), 'Schema verify catches [TBD] and broken wiki links');

assert(KeryxEngine.shouldCronRunNow({ enabled: true, schedule: 'Every 30m', lastRunTs: Date.now() - 40 * 60000 }) === true, 'Cron scheduler triggers elapsed interval');
assert(KeryxEngine.shouldCronRunNow({ enabled: true, schedule: 'Every 30m', lastRunTs: Date.now() - 5 * 60000 }) === false, 'Cron scheduler skips unelapsed interval');

const suite = KeryxEngine.runHarnessVerificationSuite(sampleState);
assert(suite.test_boundary.badge.includes('GATED') && suite.test_verification.pass === true && suite.test_recovery.pass === true, 'Harness verification suite reports live state accurately');

// Tool execution & approval boundary tests
const defs = KeryxEngine.buildToolDefinitions(sampleState.agents[0], sampleState);
assert(defs.some(d => d.name === 'wiki_read_write') && defs.some(d => d.name === 'outbound_webhook'), 'Tool definitions built for enabled agent tools');

const ctx = { agent: sampleState.agents[0], state: sampleState };
const gated = await KeryxEngine.executeToolCall(defs.find(d => d.name === 'outbound_webhook'), { message: 'hello' }, ctx);
assert(gated.approvalRequired === true && gated.pendingApproval?.toolName === 'outbound_webhook', 'Approval Gate blocks destructive outbound_webhook when unapproved');

const memRes = await KeryxEngine.executeToolCall({ name: 'persistent_memory', meta: { destructive: false } }, { action: 'write', key: 'user_tz', value: 'IST' }, ctx);
assert(memRes.saved === true && sampleState.memory.length === 1, 'persistent_memory writes enduring fact');

const evalRes = await KeryxEngine.executeToolCall({ name: 'sandbox_eval', meta: { destructive: false } }, { code: '21 * 2' }, ctx);
assert(evalRes.result === 42, 'sandbox_eval computes JS expression');

if (!process.exitCode) {
  console.log('Keryx verify passed: offline vendor assets, syntax checks, Markdown/Storage/Engine unit tests OK.');
}
