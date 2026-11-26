import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

const capCfg = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
assert(capCfg.appId === 'com.keryx.agentplatform', 'Valid appId in capacitor.config.json');
assert(capCfg.webDir === 'www', 'Valid webDir in capacitor.config.json');
assert(capCfg.plugins?.CapacitorHttp?.enabled === true, 'CapacitorHttp enabled for native CORS bypass');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'www', 'manifest.json'), 'utf8'));
assert(Boolean(manifest.name && manifest.start_url), 'Valid www/manifest.json');

const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
assert(html.includes('<meta name="color-scheme" content="light dark">'), 'color-scheme meta tag present');
assert(html.includes('<dialog id="app-sheet-dialog"'), 'Native <dialog> sheet element present');

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

assert(html.includes("api.anthropic.com/v1/messages"), 'Anthropic live BYOK endpoint wired');
assert(html.includes("Capacitor"), 'Capacitor native bridge integration present');
assert(html.includes("Agent is working…"), 'Live agent processing card present');
assert(html.includes("<details open "), 'Auto-expanded harness trace present');
assert(html.includes("btn-sim-add-key"), 'Sim mode 1-tap Add Key banner present');
assert(!html.includes("sticky bottom-0"), 'Non-overlapping composer without sticky bottom-0');
assert(html.includes("slice(-12)"), '12-turn context window present');
assert(!/ghp_[A-Za-z0-9]{20,}/.test(html), 'No hardcoded GitHub PAT in www/index.html');

if (!process.exitCode) {
  console.log('Keryx verify passed: JSON configs, HTML structure, and inline JS syntax OK.');
}
