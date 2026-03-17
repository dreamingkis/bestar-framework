// bestar-api Cloudflare Worker
// AI 생성 (Gemini) + Notion 클라이언트 데이터 자동 연동

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function corsHeaders(env) {
  return {
    ...CORS_HEADERS,
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
  };
}

function json(data, status = 200, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

// ── Gemini API 호출 ──
async function callGemini(systemPrompt, userPrompt, env) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 1024,
        },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error (${resp.status})`);
  }

  const data = await resp.json();
  return data.candidates[0].content.parts[0].text;
}

// ── Notion API 호출 ──
async function notionRequest(path, env, body = null) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`https://api.notion.com/v1${path}`, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || `Notion API error (${resp.status})`);
  }
  return resp.json();
}

// ── Notion에서 클라이언트 검색 ──
async function searchClient(name, env) {
  const data = await notionRequest('/search', env, {
    query: name,
    filter: { property: 'object', value: 'page' },
    page_size: 10,
  });

  // 결과에서 관련 페이지 필터링
  const results = data.results
    .map((page) => {
      const title = extractTitle(page);
      return {
        id: page.id,
        title,
        url: page.url,
        lastEdited: page.last_edited_time,
      };
    })
    .filter((r) => r.title && r.title.includes(name));

  return results;
}

// ── Notion 페이지 내용 가져오기 ──
async function getPageContent(pageId, env) {
  // 페이지 속성 가져오기
  const page = await notionRequest(`/pages/${pageId}`, env);
  const title = extractTitle(page);
  const props = extractProperties(page.properties);

  // 페이지 블록 내용 가져오기
  const blocks = await notionRequest(`/blocks/${pageId}/children?page_size=100`, env);
  const content = extractBlockContent(blocks.results);

  return { title, properties: props, content };
}

// ── 클라이언트 데이터 종합 수집 ──
async function getClientData(name, env) {
  const pages = await searchClient(name, env);
  if (pages.length === 0) {
    return { found: false, name, data: '해당 고객 데이터를 찾을 수 없습니다.' };
  }

  // 상위 5개 페이지의 내용 수집
  const contents = [];
  for (const page of pages.slice(0, 5)) {
    try {
      const detail = await getPageContent(page.id, env);
      contents.push(`\n--- ${detail.title || page.title} ---\n${detail.properties}\n${detail.content}`);
    } catch (e) {
      contents.push(`\n--- ${page.title} --- (내용 로드 실패)`);
    }
  }

  return {
    found: true,
    name,
    pageCount: pages.length,
    data: contents.join('\n'),
  };
}

// ── 유틸리티: Notion 데이터 추출 ──
function extractTitle(page) {
  if (!page.properties) return '';
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }
  return '';
}

function extractProperties(properties) {
  if (!properties) return '';
  const parts = [];
  for (const [key, prop] of Object.entries(properties)) {
    let val = '';
    switch (prop.type) {
      case 'title':
        val = prop.title?.map((t) => t.plain_text).join('') || '';
        break;
      case 'rich_text':
        val = prop.rich_text?.map((t) => t.plain_text).join('') || '';
        break;
      case 'select':
        val = prop.select?.name || '';
        break;
      case 'multi_select':
        val = prop.multi_select?.map((s) => s.name).join(', ') || '';
        break;
      case 'number':
        val = prop.number != null ? String(prop.number) : '';
        break;
      case 'date':
        val = prop.date?.start || '';
        break;
      case 'url':
        val = prop.url || '';
        break;
      case 'email':
        val = prop.email || '';
        break;
      case 'phone_number':
        val = prop.phone_number || '';
        break;
      case 'status':
        val = prop.status?.name || '';
        break;
      default:
        break;
    }
    if (val) parts.push(`${key}: ${val}`);
  }
  return parts.join('\n');
}

function extractBlockContent(blocks) {
  if (!blocks) return '';
  return blocks
    .map((block) => {
      const type = block.type;
      const data = block[type];
      if (!data) return '';

      // 텍스트 추출
      const richText = data.rich_text || data.text;
      if (richText) {
        const text = richText.map((t) => t.plain_text).join('');
        switch (type) {
          case 'heading_1':
            return `\n# ${text}`;
          case 'heading_2':
            return `\n## ${text}`;
          case 'heading_3':
            return `\n### ${text}`;
          case 'bulleted_list_item':
            return `- ${text}`;
          case 'numbered_list_item':
            return `• ${text}`;
          case 'to_do':
            return `${data.checked ? '✓' : '☐'} ${text}`;
          case 'quote':
            return `> ${text}`;
          case 'callout':
            return `💡 ${text}`;
          case 'toggle':
            return `▶ ${text}`;
          default:
            return text;
        }
      }

      // 테이블
      if (type === 'table') return '[표]';
      if (type === 'divider') return '---';

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// ── 요청 핸들러 ──
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const body = await request.json();

      // ── /api/generate: AI 생성 ──
      if (path === '/api/generate') {
        const { workshopData, coachingCtx, prompt } = body;

        const systemPrompt = `당신은 bestar 브랜딩 워크숍의 AI 어시스턴트입니다.
김인숙 컨설턴트의 강점 기반 브랜드 전략 방법론을 사용합니다.

핵심 원칙:
- 브랜드는 제품이 아니라 '고객의 변화'를 판다
- 강점에서 출발하여 브랜드 언어를 설계한다
- Brand House: 타겟 → 역할 → 혜택 → 가치 → 약속 → 슬로건
- 짧고 강렬하며, 한국어 자연스럽게. 마케팅 용어 남발 금지.
- 고객의 실제 데이터와 맥락에 기반한 맞춤형 결과물을 만든다.

현재 워크숍 데이터:
${workshopData || '(아직 입력된 데이터가 없습니다)'}
${coachingCtx ? `\n코칭 노트/배경 정보:\n${coachingCtx}` : ''}`;

        const result = await callGemini(systemPrompt, prompt, env);
        return json({ result }, 200, env);
      }

      // ── /api/client/search: 노션에서 고객 검색 ──
      if (path === '/api/client/search') {
        const { name } = body;
        if (!name) return json({ error: '고객명을 입력하세요' }, 400, env);
        const results = await searchClient(name, env);
        return json({ results }, 200, env);
      }

      // ── /api/client/data: 고객 데이터 수집 ──
      if (path === '/api/client/data') {
        const { name } = body;
        if (!name) return json({ error: '고객명을 입력하세요' }, 400, env);
        const data = await getClientData(name, env);
        return json(data, 200, env);
      }

      return json({ error: 'Unknown endpoint' }, 404, env);
    } catch (e) {
      return json({ error: e.message }, 500, env);
    }
  },
};
