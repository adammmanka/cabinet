import fs from 'fs/promises';
import path from 'path';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2025-09-03';
const STATE_PATH = '/Users/adammanka/clawd/state/notion-comment-watcher.state.json';

function assertEnv() {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY is not set in env');
}

async function readJsonIfExists(p, fallback) {
  try {
    const s = await fs.readFile(p, 'utf8');
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function notionFetch(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || text;
    const err = new Error(`Notion API ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function isoMinusHours(hours) {
  const d = new Date(Date.now() - hours * 3600_000);
  return d.toISOString();
}

function excerptFromRichText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(rt => rt?.plain_text || '').join('');
}

function pageTitleFromPage(page) {
  const props = page?.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === 'title') {
      const t = excerptFromRichText(v.title);
      if (t) return t;
    }
  }
  return page?.id || 'Untitled';
}

function commentPlainText(comment) {
  // Notion comment object has rich_text typically
  const rt = comment?.rich_text || comment?.comment?.rich_text;
  const t = excerptFromRichText(rt);
  return t || '';
}

function commentMentionsAdam(commentText) {
  const t = (commentText || '').toLowerCase();
  // Best-effort mention detection
  return t.includes('adam') || t.includes('@adam');
}

async function listRecentPagesFromDatabase(databaseId, sinceIso) {
  let results = [];
  let cursor;
  while (results.length < 50) {
    const body = {
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: sinceIso }
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: Math.min(50, 50 - results.length),
      start_cursor: cursor
    };
    if (!cursor) delete body.start_cursor;
    const data = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}/query`, { method: 'POST', body });
    results.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return results;
}

async function listRecentPagesFromRoot(rootPageId, sinceIso) {
  // Best-effort: fetch child blocks of root; for page blocks, also check if last_edited_time >= since
  // Notion doesn't support sorting blocks by last_edited_time; we will traverse 1 level deep.
  const pages = [];
  let cursor;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${rootPageId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const data = await notionFetch(url.toString());
    for (const b of (data.results || [])) {
      if (b.type === 'child_page' || b.type === 'child_database') {
        // child_page blocks are not full pages; need retrieve block? We'll just use block id for comments.
        // Comments API works with block_id.
        if (b.last_edited_time && b.last_edited_time >= sinceIso) pages.push(b);
      }
      if (b.type === 'link_to_page') {
        // ignore
      }
      if (b.type === 'paragraph' || b.type === 'heading_1' || b.type==='heading_2' || b.type==='heading_3') {
        // ignore content blocks
      }
    }
    cursor = data.next_cursor;
    if (!data.has_more) break;
  } while (true);
  return pages;
}

async function getCommentsForBlock(blockId) {
  // pagination
  let comments = [];
  let cursor;
  do {
    const url = new URL('https://api.notion.com/v1/comments');
    url.searchParams.set('block_id', blockId);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const data = await notionFetch(url.toString());
    comments.push(...(data.results || []));
    cursor = data.next_cursor;
    if (!data.has_more) break;
  } while (true);
  return comments;
}

async function retrievePageOrBlockTitle(blockLike) {
  // If object is a page from database query, we can title it directly.
  if (blockLike?.object === 'page') {
    return { title: pageTitleFromPage(blockLike), url: blockLike.url, id: blockLike.id };
  }
  // For child_page block, retrieve page object to get title/url
  try {
    const page = await notionFetch(`https://api.notion.com/v1/pages/${blockLike.id}`);
    return { title: pageTitleFromPage(page), url: page.url, id: page.id };
  } catch {
    return { title: blockLike?.id || 'Unknown', url: undefined, id: blockLike?.id };
  }
}

async function main() {
  assertEnv();

  const state = await readJsonIfExists(STATE_PATH, { lastRunIso: null, seenCommentIds: [] });
  const seen = new Set(state.seenCommentIds || []);

  const sinceIso = isoMinusHours(24);

  // Surface IDs: must be provided via env to avoid hardcoding secrets.
  const TASKS_DB_ID = process.env.NOTION_TASKS_DB_ID;
  const EVENTS_DB_ID = process.env.NOTION_EVENTS_QUEUE_DB_ID;
  const IMPORTS_DB_ID = process.env.NOTION_IMPORTS_QUEUE_DB_ID;
  const ROOT_PAGE_ID = process.env.NOTION_SCIPIO_ROOT_PAGE_ID;

  const missing = [];
  if (!TASKS_DB_ID) missing.push('NOTION_TASKS_DB_ID');
  if (!EVENTS_DB_ID) missing.push('NOTION_EVENTS_QUEUE_DB_ID');
  if (!IMPORTS_DB_ID) missing.push('NOTION_IMPORTS_QUEUE_DB_ID');
  if (!ROOT_PAGE_ID) missing.push('NOTION_SCIPIO_ROOT_PAGE_ID');

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const pagesBySurface = [];

  const [tasksPages, eventsPages, importsPages] = await Promise.all([
    listRecentPagesFromDatabase(TASKS_DB_ID, sinceIso),
    listRecentPagesFromDatabase(EVENTS_DB_ID, sinceIso),
    listRecentPagesFromDatabase(IMPORTS_DB_ID, sinceIso)
  ]);

  pagesBySurface.push({ surface: 'Tasks DB', pages: tasksPages });
  pagesBySurface.push({ surface: 'Events Queue DB', pages: eventsPages });
  pagesBySurface.push({ surface: 'Imports Queue DB', pages: importsPages });

  const rootRecent = await listRecentPagesFromRoot(ROOT_PAGE_ID, sinceIso);
  pagesBySurface.push({ surface: 'Scipio root page tree (1-level child pages/databases, edited<24h)', pages: rootRecent });

  const findings = [];

  for (const { surface, pages } of pagesBySurface) {
    for (const p of pages) {
      const meta = await retrievePageOrBlockTitle(p);
      const blockId = meta.id;
      const comments = await getCommentsForBlock(blockId);
      for (const c of comments) {
        const id = c.id;
        if (seen.has(id)) continue;
        const created = c.created_time || c?.created_time;
        const text = commentPlainText(c);
        const author = c?.created_by?.name || c?.created_by?.id || 'Unknown';

        // Filter: from Adam OR mentions Adam
        const fromAdam = (author || '').toLowerCase().includes('adam');
        const mentionsAdam = commentMentionsAdam(text);

        // Also constrain to last 24h by created_time if present
        const inWindow = created ? (created >= sinceIso) : true;

        if (inWindow && (fromAdam || mentionsAdam)) {
          findings.push({
            surface,
            pageId: meta.id,
            pageTitle: meta.title,
            pageUrl: meta.url,
            commentId: id,
            createdTime: created,
            author,
            excerpt: text.slice(0, 280).trim(),
            fullText: text
          });
        }
      }
    }
  }

  // Update state
  const newSeen = new Set([...(state.seenCommentIds || []), ...findings.map(f => f.commentId)]);
  const nextState = {
    lastRunIso: new Date().toISOString(),
    seenCommentIds: Array.from(newSeen).slice(-5000) // cap
  };
  await writeJson(STATE_PATH, nextState);

  // Print report
  const out = {
    sinceIso,
    lastRunIso: nextState.lastRunIso,
    totalNewMatchingComments: findings.length,
    findings
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('ERROR:', err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
