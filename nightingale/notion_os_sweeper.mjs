import fs from 'fs/promises';
import path from 'path';

/**
 * Notion OS Sweeper
 *
 * Requirements (per user instruction):
 * - Surfaces: Tasks DB, Events Queue DB, Imports Queue DB
 * - Use Notion-Version: 2025-09-03
 * - For each DB: GET database to obtain data_source_id, then query via data source endpoint.
 * - Compare with state file lastRunIso; report grouped A-D.
 * - Include comments since lastRunIso.
 * - Update state only after successful report.
 * - No Notion edits.
 */

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = '2025-09-03';

const STATE_PATH = '/Users/adammanka/clawd/state/notion-sweeper.state.json';

// Provide DB ids via env (no Notion edits / discovery here).
const TASKS_DB_ID = process.env.NOTION_TASKS_DB_ID;
const EVENTS_QUEUE_DB_ID = process.env.NOTION_EVENTS_QUEUE_DB_ID;
const IMPORTS_QUEUE_DB_ID = process.env.NOTION_IMPORTS_QUEUE_DB_ID;

const PAGE_SIZE = 50;
const MAX_PAGES = 200;

function assertEnv() {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY is not set in env');
}

async function readJson(p) {
  const s = await fs.readFile(p, 'utf8');
  return JSON.parse(s);
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function notionFetch(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || text;
    const err = new Error(`Notion API ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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

async function getDatabaseAndDataSourceId(databaseId) {
  const db = await notionFetch(`https://api.notion.com/v1/databases/${databaseId}`);
  // Notion 2025-09-03 returns `data_sources: [{id,name}]` rather than `data_source_id`.
  const dataSourceId = db?.data_source_id || db?.data_sources?.[0]?.id;
  if (!dataSourceId) {
    const err = new Error(`Database ${databaseId} missing data_source_id/data_sources[0].id (integration or API mismatch?)`);
    err.data = db;
    throw err;
  }
  return { database: db, dataSourceId };
}

async function queryDataSource(dataSourceId, { editedSinceIso } = {}) {
  const results = [];
  let cursor;
  while (results.length < MAX_PAGES) {
    const body = {
      page_size: Math.min(PAGE_SIZE, MAX_PAGES - results.length),
      start_cursor: cursor,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }]
    };
    if (!cursor) delete body.start_cursor;

    if (editedSinceIso) {
      body.filter = {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: editedSinceIso }
      };
    }

    const data = await notionFetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body
    });

    results.push(...(data.results || []));
    if (!data.has_more) break;
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return results;
}

async function getCommentsSince(blockId, sinceIso) {
  const out = [];
  let cursor;
  do {
    const url = new URL('https://api.notion.com/v1/comments');
    url.searchParams.set('block_id', blockId);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const data = await notionFetch(url.toString());
    for (const c of data.results || []) {
      const created = c?.created_time;
      if (!sinceIso || !created || created >= sinceIso) {
        out.push(c);
      }
    }
    cursor = data.next_cursor;
    if (!data.has_more) break;
  } while (true);
  return out;
}

function classifyItem({ page, commentsSince, wasSeen }) {
  // A: New items since last run (created_time >= lastRunIso)
  // B: Updated items since last run (last_edited_time >= lastRunIso but created_time < lastRunIso)
  // C: Comments since last run
  // D: Previously seen / unchanged (not reported unless explicitly needed)
  const created = page?.created_time;
  const edited = page?.last_edited_time;

  if ((commentsSince || []).length) return 'C';
  if (wasSeen) return 'D';
  if (created && edited && created === edited) return 'A';
  return 'B';
}

async function main() {
  assertEnv();

  const state = await readJson(STATE_PATH);
  const lastRunIso = state?.lastRunIso ?? null;
  // Per sweeper rules: initialize to null if missing; treat null as full sweep.

  const surfaces = [
    { key: 'Tasks', name: 'Tasks DB', dbId: TASKS_DB_ID, seenKey: 'Tasks' },
    { key: 'EventsQueue', name: 'Events Queue DB', dbId: EVENTS_QUEUE_DB_ID, seenKey: 'EventsQueue' },
    { key: 'ImportsQueue', name: 'Imports Queue DB', dbId: IMPORTS_QUEUE_DB_ID, seenKey: 'ImportsQueue' }
  ];

  const missing = surfaces.filter(s => !s.dbId).map(s => s.key);
  if (missing.length) {
    throw new Error(
      `Missing env DB ids for: ${missing.join(', ')}. Set NOTION_TASKS_DB_ID, NOTION_EVENTS_QUEUE_DB_ID, NOTION_IMPORTS_QUEUE_DB_ID.`
    );
  }

  const report = {
    ranAtIso: new Date().toISOString(),
    lastRunIso,
    bySurface: {}
  };

  // Build report first; only if fully successful, update state.
  for (const s of surfaces) {
    // state.seenIds is persisted as an object map: { [pageId]: lastSeenIso }
    const seenIdsMap = state?.seenIds?.[s.seenKey] || {};
    const seenIds = new Set(Object.keys(seenIdsMap));

    const { database, dataSourceId } = await getDatabaseAndDataSourceId(s.dbId);

    const pages = await queryDataSource(dataSourceId, { editedSinceIso: lastRunIso });

    const items = [];
    const groups = { A: [], B: [], C: [], D: [] };

    for (const p of pages) {
      const pageId = p.id;
      const wasSeen = seenIds.has(pageId);
      const title = pageTitleFromPage(p);
      const url = p.url;

      const comments = await getCommentsSince(pageId, lastRunIso);
      const commentsSlim = (comments || []).map(c => ({
        id: c.id,
        created_time: c.created_time,
        created_by: c?.created_by?.name || c?.created_by?.id || 'Unknown',
        text: commentPlainText(c).slice(0, 500)
      }));

      const group = classifyItem({ page: p, commentsSince: commentsSlim, wasSeen });

      const item = {
        id: pageId,
        title,
        url,
        created_time: p.created_time,
        last_edited_time: p.last_edited_time,
        group,
        commentsSinceLastRun: commentsSlim
      };

      items.push(item);
      groups[group].push(item);
    }

    report.bySurface[s.key] = {
      surfaceName: s.name,
      databaseId: s.dbId,
      dataSourceId,
      databaseTitle: database?.title ? excerptFromRichText(database.title) : null,
      totals: {
        queriedPages: pages.length,
        A: groups.A.length,
        B: groups.B.length,
        C: groups.C.length,
        D: groups.D.length
      },
      groups
    };
  }

  // Successful report. Now update state: lastRunIso and seenIds.
  const nextState = structuredClone(state);
  nextState.lastRunIso = report.ranAtIso;
  for (const s of surfaces) {
    const cur = nextState?.seenIds?.[s.seenKey] || {};
    const surfaced = report.bySurface[s.key];
    for (const g of ['A', 'B', 'C', 'D']) {
      for (const it of surfaced.groups[g]) {
        cur[it.id] = it.last_edited_time || report.ranAtIso;
      }
    }
    // keep map bounded
    const entries = Object.entries(cur)
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .slice(0, 2000);
    nextState.seenIds[s.seenKey] = Object.fromEntries(entries);
  }

  // Emit report to stdout as JSON so caller can format.
  console.log(JSON.stringify(report, null, 2));

  await writeJson(STATE_PATH, nextState);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
