(function (globalScope) {
  'use strict';

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderInline(raw) {
    let line = escapeHtml(raw);
    // Inline code first using placeholders so bold/italic/links don't touch code spans
    const codeTokens = [];
    line = line.replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeTokens.length;
      codeTokens.push('<code class="font-mono-code text-[12px] px-1 py-0.5 rounded" style="background:var(--surface-2);">' + code + '</code>');
      return '\x00CODE' + idx + '\x00';
    });

    // Markdown links [text](https://...)
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      return '<button type="button" class="underline font-medium cursor-pointer" style="color:var(--accent);" data-ext-url="' + url + '">' + label + '</button>';
    });

    // Wikilinks [[Title]]
    line = line.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      return '<button type="button" class="wikilink" data-wikilink="' + title + '">[[' + title + ']]</button>';
    });

    // Bold & italic
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');

    // Restore inline code
    line = line.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeTokens[Number(i)] || '');
    return line;
  }

  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let listType = null; // 'ul' | 'ol'
    let inCode = false;
    let codeLang = '';
    let codeLines = [];
    let tableRows = [];

    function flushList() {
      if (listType) {
        html += listType === 'ol' ? '</ol>' : '</ul>';
        listType = null;
      }
    }

    function flushTable() {
      if (!tableRows.length) return;
      const bodyRows = tableRows.filter(r => !/^\|?[\s:-]+\|/.test(r.trim()));
      if (!bodyRows.length) { tableRows = []; return; }
      const parseCells = row => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const headers = parseCells(bodyRows[0]);
      const dataRows = bodyRows.slice(1).map(parseCells);
      html += '<div class="overflow-x-auto my-2"><table class="w-full text-xs border-collapse" style="border:1px solid var(--border);">';
      html += '<thead><tr style="background:var(--surface-2);">' + headers.map(h => '<th class="text-left px-2 py-1.5 font-semibold" style="border:1px solid var(--border);">' + renderInline(h) + '</th>').join('') + '</tr></thead>';
      if (dataRows.length) {
        html += '<tbody>' + dataRows.map(cols => '<tr>' + cols.map(c => '<td class="px-2 py-1.5" style="border:1px solid var(--border);">' + renderInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      }
      html += '</table></div>';
      tableRows = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const fenceMatch = raw.match(/^```([a-zA-Z0-9_-]*)\s*$/);
      if (fenceMatch) {
        flushList();
        flushTable();
        if (!inCode) {
          inCode = true;
          codeLang = fenceMatch[1] || 'code';
          codeLines = [];
        } else {
          const rawCode = codeLines.join('\n');
          const encoded = escapeHtml(rawCode);
          html += '<div class="my-2 rounded-xl overflow-hidden border" style="border-color:var(--border); background:var(--surface-2);">' +
            '<div class="flex items-center justify-between px-2.5 py-1 border-b text-[10px] font-mono-code" style="border-color:var(--border); color:var(--muted);">' +
            '<span>' + escapeHtml(codeLang) + '</span>' +
            '<button type="button" class="underline cursor-pointer" data-copy-code="' + encoded + '">Copy</button>' +
            '</div>' +
            '<pre class="p-2.5 text-[11.5px] font-mono-code overflow-x-auto leading-relaxed"><code>' + encoded + '</code></pre>' +
            '</div>';
          inCode = false;
          codeLang = '';
          codeLines = [];
        }
        continue;
      }

      if (inCode) {
        codeLines.push(raw);
        continue;
      }

      if (/^\|.+\|/.test(raw.trim())) {
        flushList();
        tableRows.push(raw.trim());
        continue;
      } else {
        flushTable();
      }

      if (raw.startsWith('### ')) {
        flushList();
        html += '<h4 class="font-display text-[13px] font-bold mt-3 mb-1">' + renderInline(raw.slice(4)) + '</h4>';
      } else if (raw.startsWith('## ')) {
        flushList();
        html += '<h3 class="font-display text-sm font-bold mt-3.5 mb-1.5">' + renderInline(raw.slice(3)) + '</h3>';
      } else if (raw.startsWith('# ')) {
        flushList();
        html += '<h2 class="font-display text-lg font-bold mt-1 mb-2">' + renderInline(raw.slice(2)) + '</h2>';
      } else if (/^>\s?/.test(raw)) {
        flushList();
        html += '<blockquote class="pl-3 my-1.5 border-l-2 text-[13px] italic" style="border-color:var(--accent); color:var(--muted);">' + renderInline(raw.replace(/^>\s?/, '')) + '</blockquote>';
      } else if (/^[-*]\s+/.test(raw)) {
        if (listType !== 'ul') {
          flushList();
          html += '<ul class="list-disc pl-5 space-y-1 my-1.5">';
          listType = 'ul';
        }
        html += '<li class="text-[13.5px]">' + renderInline(raw.replace(/^[-*]\s+/, '')) + '</li>';
      } else if (/^\d+\.\s+/.test(raw)) {
        if (listType !== 'ol') {
          flushList();
          html += '<ol class="list-decimal pl-5 space-y-1 my-1.5">';
          listType = 'ol';
        }
        html += '<li class="text-[13.5px]">' + renderInline(raw.replace(/^\d+\.\s+/, '')) + '</li>';
      } else if (/^---+$/.test(raw.trim())) {
        flushList();
        html += '<hr class="my-3" style="border-color:var(--border);" />';
      } else if (raw.trim() === '') {
        flushList();
      } else {
        flushList();
        html += '<p class="text-[13.5px] my-1.5">' + renderInline(raw) + '</p>';
      }
    }

    if (inCode && codeLines.length) {
      const encoded = escapeHtml(codeLines.join('\n'));
      html += '<pre class="my-2 p-2.5 rounded-xl text-[11.5px] font-mono-code overflow-x-auto" style="background:var(--surface-2); border:1px solid var(--border);"><code>' + encoded + '</code></pre>';
    }
    flushList();
    flushTable();
    return html;
  }

  const api = { escapeHtml, renderMarkdown };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.KeryxMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
