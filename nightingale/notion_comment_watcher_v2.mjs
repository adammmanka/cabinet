import fs from 'fs/promises';
import path from 'path';

/**
 * Notion Comment Watcher v2
 *
 * Goals:
 * - Only hardcode the Scipio root page id (reference root)
 * - Discover Tasks / Events / Imports database ids from a Reference page under the root
 *   or by searching descendants.
 * - Scan recently edited pages in those DBs, fetch comments, filter those by Adam.
 * - Persist state in /Users/adammanka/clawd/state/notion-comment-watcher.state.json
 *
 * Constraints:
 * - No env vars for ids; only NOTION_API_KEY must exist.
 */

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2025-09-03';

// Single hardcoded reference/root page id ("Scipio — Command & Conquer")
const ROOT_PAGE_ID = '2fa1d864-d3cb-8101-9a94-d0a18b5a781d';

const STATE_PATH = '/Users/adammanka/clawd/state/notion-comment-watcher.state.json';

// Heuristics
const LOOKBACK_HOURS_DEFAULT = 24;
const MAX_PAGES_PER_DB = 50;
const MAX_COMMENTS_SEEN = 5000;

function assertEnv() {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY is not set in env');
}

async function readJsonIfExists(p, fallback) {
  try {
    const s = await fs.readFile(p, 'utf8');
    return JSON.parse(s);
  } catch {
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
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function excerptFromRichText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText.map(rt => rt?.plain_text || '').join('');
}

function pageTitleFromPage(page) {
  const props = page?.properties || {};
  for (const v of Object.values(props)) {
    if (v?.type === 'title') {
      const t = excerptFromRichText(v.title);
      if (t) return t;
    }
  }
  return page?.id || 'Untitled';
}

function commentPlainText(comment) {
  const rt = comment?.rich_text || comment?.comment?.rich_text;
  return excerptFromRichText(rt) || '';
}

function authorLooksLikeAdam(nameOrId) {
  const t = String(nameOrId || '').toLowerCase();
  return t.includes('adam');
}

async function retrievePageMeta(pageId) {
  const page = await notionFetch(`https://api.notion.com/v1/pages/${pageId}`);
  return { id: page.id, url: page.url, title: pageTitleFromPage(page), raw: page };
}

async function listBlockChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const data = await notionFetch(url.toString());
    out.push(...(data.results || []));
    cursor = data.next_cursor;
    if (!data.has_more) break;
  } while (true);
  return out;
}

function normalizeId(id) {
  if (!id) return null;
  // Accept either dashed or not; Notion APIs generally accept dashed.
  const s = String(id).trim();
  // if it looks like a URL, try extract last segment
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  } catch {}
  return s;
}

async function searchAllUnderRoot(rootPageId, query) {
  // Notion search can scope by ancestor via filter: {property:'object', value:'page'|'database'}
  // There isn't an explicit ancestor filter in v1.
  // Best-effort: global search + post-filter by checking if the result appears in descendants traversal.
  // We'll do descendant traversal and name-match locally (more reliable).
  const descendants = await traverseDescendants(rootPageId, { maxNodes: 1200 });
  const q = String(query || '').toLowerCase();
  return descendants.filter(d => (d.title || '').toLowerCase().includes(q));
}

async function traverseDescendants(rootPageId, { maxNodes = 1000 } = {}) {
  // BFS over child_page and child_database blocks.
  // Safety: cap the number of page expansions because Notion block trees can be huge.
  const queue = [{ type: 'page', id: rootPageId, title: '(root)' }];
  const seen = new Set();
  const found = [];
  let expandedPages = 0;
  const MAX_PAGE_EXPANSIONS = Math.max(50, Math.floor(maxNodes / 2));

  while (queue.length && found.length < maxNodes) {
    const cur = queue.shift();
    const key = `${cur.type}:${cur.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    expandedPages += 1;
    if (expandedPages > MAX_PAGE_EXPANSIONS) break;

    const children = await listBlockChildren(cur.id);
    for (const b of children) {
      if (b.type === 'child_page') {
        const title = b.child_page?.title || 'Untitled';
        found.push({ object: 'page', id: b.id, title });
        queue.push({ type: 'page', id: b.id, title });
      } else if (b.type === 'child_database') {
        const title = b.child_database?.title || 'Untitled';
        found.push({ object: 'database', id: b.id, title });
        // databases can have pages but not child blocks in same way; no enqueue.
      }
    }
  }

  return found;
}

async function findReferencePageIdUnderRoot(rootPageId) {
  const descendants = await traverseDescendants(rootPageId, { maxNodes: 2000 });
  const ref = descendants.find(d => d.object === 'page' && (d.title || '').toLowerCase() === 'reference');
  return ref?.id || null;
}

async function parseReferencePageForDbIds(referencePageId) {
  // Strategy: read blocks and look for patterns:
  // - plain text like "Tasks DB: <id>" / "Events DB: <id>" / "Imports DB: <id>"
  // - database mentions embedded as links (notion:// or https). We'll attempt to extract ids from any URLs.

  const blocks = await listBlockChildren(referencePageId);
  const textBlobs = [];

  for (const b of blocks) {
    const t = b.type;
    if (t === 'paragraph') textBlobs.push(excerptFromRichText(b.paragraph?.rich_text));
    if (t === 'heading_1') textBlobs.push(excerptFromRichText(b.heading_1?.rich_text));
    if (t === 'heading_2') textBlobs.push(excerptFromRichText(b.heading_2?.rich_text));
    if (t === 'heading_3') textBlobs.push(excerptFromRichText(b.heading_3?.rich_text));
    if (t === 'bulleted_list_item') textBlobs.push(excerptFromRichText(b.bulleted_list_item?.rich_text));
    if (t === 'numbered_list_item') textBlobs.push(excerptFromRichText(b.numbered_list_item?.rich_text));
    if (t === 'to_do') textBlobs.push(excerptFromRichText(b.to_do?.rich_text));
    if (t === 'quote') textBlobs.push(excerptFromRichText(b.quote?.rich_text));
    if (t === 'callout') textBlobs.push(excerptFromRichText(b.callout?.rich_text));

    // Collect any URLs that might contain ids
    if (b[t]?.rich_text) {
      for (const rt of b[t].rich_text) {
        const href = rt?.href;
        if (href) textBlobs.push(href);
      }
    }
  }

  const joined = textBlobs.filter(Boolean).join('\n');

  function findLineValue(label) {
    const re = new RegExp(`${label}\\s*[:=]\\s*([0-9a-fA-F-]{32,})`, 'i');
    const m = joined.match(re);
    return m?.[1] || null;
  }

  const tasks = normalizeId(findLineValue('tasks'));
  const events = normalizeId(findLineValue('events'));
  const imports = normalizeId(findLineValue('imports'));

  return {
    tasksDbId: tasks,
    eventsDbId: events,
    importsDbId: imports,
    rawText: joined
  };
}

async function createReferencePageUnderRoot(rootPageId) {
  // If integration lacks permission, this will fail with 403.
  const created = await notionFetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    body: {
      parent: { page_id: rootPageId },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: 'Reference' } }]
        }
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: 'Notion Comment Watcher v2 Reference Page' } }]
          }
        },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: 'Fill these in (use database IDs or full URLs):' } }]
          }
        },
        {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: 'Tasks: <TASKS_DATABASE_ID_OR_URL>' } }]
          }
        },
        {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: 'Events: <EVENTS_DATABASE_ID_OR_URL>' } }]
          }
        },
        {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: 'Imports: <IMPORTS_DATABASE_ID_OR_URL>' } }]
          }
        }
      ]
    }
  });

  return created?.id || null;
}

async function listRecentPagesFromDatabase(databaseId, sinceIso, maxPages = MAX_PAGES_PER_DB) {
  let results = [];
  let cursor;
  while (results.length < maxPages) {
    const body = {
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: sinceIso }
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: Math.min(50, maxPages - results.length),
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

async function getCommentsForBlock(blockId) {
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

async function resolvePageMetaFromPageObject(pageObj) {
  return { id: pageObj.id, url: pageObj.url, title: pageTitleFromPage(pageObj) };
}

async function runScan({ tasksDbId, eventsDbId, importsDbId, sinceIso, seenCommentIds }) {
  const seen = new Set(seenCommentIds || []);
  const findings = [];

  const surfaces = [
    { surface: 'Tasks DB', dbId: tasksDbId },
    { surface: 'Events DB', dbId: eventsDbId },
    { surface: 'Imports DB', dbId: importsDbId }
  ].filter(s => s.dbId);

  // Query recent pages in each DB, then get comments for each page
  for (const s of surfaces) {
    const pages = await listRecentPagesFromDatabase(s.dbId, sinceIso, MAX_PAGES_PER_DB);
    for (const p of pages) {
      const meta = await resolvePageMetaFromPageObject(p);
      const comments = await getCommentsForBlock(meta.id);
      for (const c of comments) {
        if (seen.has(c.id)) continue;

        const text = commentPlainText(c);
        const author = c?.created_by?.name || c?.created_by?.id || 'Unknown';
        const created = c?.created_time;
        const inWindow = created ? (created >= sinceIso) : true;

        // v2 requirement says "filter those by Adam". We'll treat "by Adam" as created_by name contains "adam".
        const fromAdam = authorLooksLikeAdam(author);

        if (inWindow && fromAdam) {
          findings.push({
            surface: s.surface,
            databaseId: s.dbId,
            pageId: meta.id,
            pageTitle: meta.title,
            pageUrl: meta.url,
            commentId: c.id,
            createdTime: created,
            author,
            excerpt: text.slice(0, 280).trim(),
            fullText: text
          });
        }
      }
    }
  }

  findings.sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')));

  const newlySeen = [...findings.map(f => f.commentId)];
  const nextSeen = Array.from(new Set([...(seenCommentIds || []), ...newlySeen])).slice(-MAX_COMMENTS_SEEN);

  return { findings, nextSeen };
}

async function main() {
  assertEnv();

  const state = await readJsonIfExists(STATE_PATH, {
    lastRunIso: null,
    seenCommentIds: [],
    referencePageId: null,
    discovered: { tasksDbId: null, eventsDbId: null, importsDbId: null }
  });

  const sinceIso = isoMinusHours(LOOKBACK_HOURS_DEFAULT);

  // 1) Find or create Reference page
  let referencePageId = state.referencePageId;
  if (!referencePageId) {
    referencePageId = await findReferencePageIdUnderRoot(ROOT_PAGE_ID);
  }

  let referenceCreated = false;
  if (!referencePageId) {
    try {
      referencePageId = await createReferencePageUnderRoot(ROOT_PAGE_ID);
      referenceCreated = true;
    } catch (err) {
      // Cannot create; will print instructions later.
      referencePageId = null;
    }
  }

  let ids = { tasksDbId: null, eventsDbId: null, importsDbId: null };
  let referenceRawText = null;

  if (referencePageId) {
    const parsed = await parseReferencePageForDbIds(referencePageId);
    ids = {
      tasksDbId: parsed.tasksDbId,
      eventsDbId: parsed.eventsDbId,
      importsDbId: parsed.importsDbId
    };
    referenceRawText = parsed.rawText;
  }

  // 2) Fallback discovery by descendant name search
  // If any ids missing, try to locate child databases by name.
  if (!ids.tasksDbId || !ids.eventsDbId || !ids.importsDbId) {
    const descendants = await traverseDescendants(ROOT_PAGE_ID, { maxNodes: 2000 });
    const dbs = descendants.filter(d => d.object === 'database');

    function pickDbIdByName(needle) {
      const n = needle.toLowerCase();
      const hit = dbs.find(d => (d.title || '').toLowerCase().includes(n));
      return hit?.id || null;
    }

    if (!ids.tasksDbId) ids.tasksDbId = pickDbIdByName('tasks');
    if (!ids.eventsDbId) ids.eventsDbId = pickDbIdByName('events');
    if (!ids.importsDbId) ids.importsDbId = pickDbIdByName('imports');
  }

  const missingIds = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);

  // Persist discovery even if missing
  const nextStateBase = {
    ...state,
    lastRunIso: new Date().toISOString(),
    referencePageId: referencePageId || state.referencePageId || null,
    discovered: { ...ids }
  };

  if (missingIds.length) {
    await writeJson(STATE_PATH, nextStateBase);

    const rootMeta = await retrievePageMeta(ROOT_PAGE_ID);

    const instructions = {
      error: 'Missing required database ids',
      missing: missingIds,
      rootPage: { id: rootMeta.id, title: rootMeta.title, url: rootMeta.url },
      referencePage: referencePageId
        ? { id: referencePageId, createdNow: referenceCreated }
        : { id: null, createdNow: false },
      howToFix: referencePageId
        ? [
            'Open the Reference page under the Scipio root.',
            'Add lines (or bullets) exactly like:',
            '  Tasks: <TASKS_DATABASE_ID_OR_URL>',
            '  Events: <EVENTS_DATABASE_ID_OR_URL>',
            '  Imports: <IMPORTS_DATABASE_ID_OR_URL>',
            'Re-run: node notion_comment_watcher_v2.mjs'
          ]
        : [
            'The integration could not create the Reference page (likely missing permissions).',
            'Manual steps for Adam:',
            `1) Open the Scipio root page: ${rootMeta.url}`,
            '2) Create a new sub-page titled exactly: Reference',
            '3) In that page, add bullets/lines:',
            '   - Tasks: <TASKS_DATABASE_ID_OR_URL>',
            '   - Events: <EVENTS_DATABASE_ID_OR_URL>',
            '   - Imports: <IMPORTS_DATABASE_ID_OR_URL>',
            '4) Ensure the integration has access to that Reference page and the target databases.',
            '5) Re-run: node notion_comment_watcher_v2.mjs'
          ]
    };

    console.log(JSON.stringify(instructions, null, 2));
    return;
  }

  // 3) Run scan
  const { findings, nextSeen } = await runScan({
    ...ids,
    sinceIso,
    seenCommentIds: state.seenCommentIds
  });

  const nextState = {
    ...nextStateBase,
    seenCommentIds: nextSeen
  };
  await writeJson(STATE_PATH, nextState);

  const mostRecent = findings[0] || null;

  console.log(
    JSON.stringify(
      {
        sinceIso,
        lastRunIso: nextState.lastRunIso,
        referencePageId: nextState.referencePageId,
        discoveredDatabaseIds: nextState.discovered,
        referenceCreatedNow: referenceCreated,
        referenceRawText: referenceRawText ? referenceRawText.slice(0, 2000) : null,
        totalNewCommentsByAdam: findings.length,
        mostRecent,
        findings
      },
      null,
      2
    )
  );
}

main().catch(err => {
  console.error('ERROR:', err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
