import { describe, expect, it, vi } from 'vitest';
import { createMicrosoftGraphOneNoteClient } from './client';
import {
  directSectionsFixture,
  experimentPagesFixture,
  GRAPH_FIXTURE_ROOT,
  groupedSectionsFixture,
  pageHtmlFixtures,
  paginatedNotebookFixture,
  paginatedPagesFixture,
  resourceBodiesFixture,
  rootSectionGroupsFixture,
  secondPagesFixture,
} from './fixtures';
import { extractGraphResourceReferences } from './resourceReferences';
import type { GraphFetch, MicrosoftGraphOneNoteClientOptions } from './types';

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function html(value: string): Response {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function binary(value: Uint8Array, mediaType: string, extraHeaders: HeadersInit = {}): Response {
  const body = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  return new Response(body, { headers: { 'content-type': mediaType, 'content-length': String(value.byteLength), ...extraHeaders } });
}

function testOptions(fetch: GraphFetch, overrides: Partial<MicrosoftGraphOneNoteClientOptions> = {}): MicrosoftGraphOneNoteClientOptions {
  return {
    getAccessToken: async () => 'fixture-token',
    fetch,
    sha256: async (bytes) => (bytes[0] ?? 0).toString(16).padStart(2, '0').repeat(32),
    retry: { maxRetries: 0 },
    ...overrides,
  };
}

function realisticFetch(calls: Array<{ url: string; init: RequestInit }>): GraphFetch {
  return async (input, init) => {
    calls.push({ url: input, init });
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith('/notebooks')) {
      return json(url.searchParams.has('$skiptoken') ? { value: [] } : paginatedNotebookFixture);
    }
    if (path.endsWith('/notebooks/notebook-physics/sections')) return json(directSectionsFixture);
    if (path.endsWith('/notebooks/notebook-physics/sectionGroups')) return json(rootSectionGroupsFixture);
    if (path.endsWith('/sectionGroups/group-labs/sections')) return json(groupedSectionsFixture);
    if (path.endsWith('/sectionGroups/group-labs/sectionGroups')) return json({ value: [] });
    if (path.endsWith('/sections/section-mechanics/pages')) {
      return json(url.searchParams.has('$skiptoken') ? secondPagesFixture : paginatedPagesFixture);
    }
    if (path.endsWith('/sections/section-experiments/pages')) return json(experimentPagesFixture);
    const pageMatch = /\/pages\/([^/]+)\/content$/.exec(path);
    if (pageMatch) return html(pageHtmlFixtures[decodeURIComponent(pageMatch[1])]);
    const resourceMatch = /\/resources\/([^/]+)\/content$/.exec(path);
    if (resourceMatch) {
      const fixture = resourceBodiesFixture[decodeURIComponent(resourceMatch[1])];
      return binary(fixture.body, fixture.mediaType);
    }
    return json({ error: { code: 'notFound' } }, { status: 404, headers: { 'request-id': 'fixture-request-id' } });
  };
}

function minimalHierarchyFetch(pageHtml: string, resourceResponse?: Response): GraphFetch {
  return async (input) => {
    const url = new URL(input);
    const path = url.pathname;
    if (path.endsWith('/notebooks')) return json({ value: [{ id: 'nb', displayName: 'Notebook' }] });
    if (path.endsWith('/notebooks/nb/sections')) return json({ value: [{ id: 'section', displayName: 'Section' }] });
    if (path.endsWith('/notebooks/nb/sectionGroups')) return json({ value: [] });
    if (path.endsWith('/sections/section/pages')) return json({ value: [{ id: 'page', title: 'Page', order: 0, level: 0 }] });
    if (path.endsWith('/pages/page/content')) return html(pageHtml);
    if (path.includes('/resources/')) return resourceResponse ?? binary(new Uint8Array([1]), 'application/octet-stream');
    return json({}, { status: 404 });
  };
}

describe('Microsoft Graph OneNote acquisition', () => {
  it('acquires paginated hierarchy, HTML, images, attachments, and feeds the preview importer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createMicrosoftGraphOneNoteClient(testOptions(realisticFetch(calls)));
    const result = await client.acquirePreview({
      preview: { createdAt: '2026-08-03T13:00:00Z' },
    });

    expect(result.input.notebooks).toHaveLength(1);
    expect(result.input.notebooks[0].sections.map((section) => [section.id, section.groupPath])).toEqual([
      ['section-mechanics', undefined], ['section-experiments', ['Lab work']],
    ]);
    expect(result.preview.notebooks[0].sections.map((section) => [section.displayName, section.groupPath])).toEqual([
      ['Mechanics', undefined], ['Experiments', ['Lab work']],
    ]);
    expect(result.input.notebooks[0].sections[0].pages.map((page) => [page.id, page.order, page.level])).toEqual([
      ['page-laws', 1, 0], ['page-diagram', 0, 1],
    ]);
    expect(result.input.resources).toMatchObject([
      { id: 'image-force', mediaType: 'image/png', byteLength: 4 },
      { id: 'file-lab', mediaType: 'text/csv', fileName: 'pendulum-results.csv' },
    ]);
    expect(result.resourceBodies.map((resource) => resource.bytes.byteLength)).toEqual([4, 18]);
    expect(result.preview.notebooks[0].sections[0].pages.map((page) => page.sourceId)).toEqual([
      'page-diagram', 'page-laws',
    ]);
    expect(result.preview.notebooks[0].sections[0].pages[0].blocks).toMatchObject([{
      type: 'spatialGroup',
      blocks: [expect.objectContaining({ type: 'image', resourceId: 'image-force' })],
    }]);
    expect(result.preview.notebooks[0].sections[0].pages[1].blocks.map((block) => block.type)).toEqual([
      'heading', 'checklist', 'list',
    ]);
    expect(result.preview.notebooks[0].sections[1].pages[0].blocks.map((block) => block.type)).toEqual([
      'table', 'attachment',
    ]);
    expect(result.preview.summary).toEqual({ complete: 2, visual: 0, simplified: 1, unsupported: 0 });
    expect(result.preview.pageReports.find((report) => report.pageId === 'page-diagram')?.issues)
      .toContainEqual(expect.objectContaining({ code: 'image-resource-missing' }));
    expect(result.stats.requests).toBe(calls.length);
    expect(result.stats.retries).toBe(0);
    expect(result.stats.resourceBytes).toBe(22);
    expect(calls.every((call) => new Headers(call.init.headers).get('authorization') === 'Bearer fixture-token')).toBe(true);
    expect(calls.every((call) => call.init.redirect === 'error' && call.init.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-token');
  });

  it('carries the names of nested section groups into each section', async () => {
    const base = minimalHierarchyFetch('<p>x</p>');
    const client = createMicrosoftGraphOneNoteClient(testOptions(async (input, init) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/notebooks/nb/sectionGroups')) return json({ value: [{ id: 'done', displayName: 'z_Abgeschlossen' }] });
      if (path.endsWith('/sectionGroups/done/sections')) return json({ value: [] });
      if (path.endsWith('/sectionGroups/done/sectionGroups')) return json({ value: [{ id: 'science', displayName: 'Naturwissenschaft' }] });
      if (path.endsWith('/sectionGroups/science/sections')) return json({ value: [{ id: 'physics', displayName: 'Physik' }] });
      if (path.endsWith('/sectionGroups/science/sectionGroups')) return json({ value: [] });
      if (path.endsWith('/sections/physics/pages')) return json({ value: [] });
      return base(input, init);
    }));
    const result = await client.acquire();
    expect(result.input.notebooks[0].sections.map((section) => [section.displayName, section.groupPath])).toEqual([
      ['Section', undefined], ['Physik', ['z_Abgeschlossen', 'Naturwissenschaft']],
    ]);
  });

  it('honors Retry-After and bounds retries', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fetch: GraphFetch = async () => {
      attempts += 1;
      return attempts === 1
        ? json({ error: { code: 'TooManyRequests' } }, { status: 429, headers: { 'retry-after': '2' } })
        : json({ value: [] });
    };
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch, {
      retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 5_000 },
      delay: async (milliseconds) => { delays.push(milliseconds); },
    }));

    const result = await client.acquire();
    expect(result.input.notebooks).toEqual([]);
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
    expect(result.stats.retries).toBe(1);

    let exhaustedAttempts = 0;
    const exhaustedClient = createMicrosoftGraphOneNoteClient(testOptions(async () => {
      exhaustedAttempts += 1;
      return json({}, { status: 429, headers: { 'retry-after': '0' } });
    }, {
      retry: { maxRetries: 1 },
      delay: async () => undefined,
    }));
    await expect(exhaustedClient.acquire()).rejects.toMatchObject({
      code: 'http-error', status: 429, retryable: true,
    });
    expect(exhaustedAttempts).toBe(2);
  });

  it('stops pagination at the configured response bound', async () => {
    let calls = 0;
    const fetch: GraphFetch = async () => {
      calls += 1;
      return json({
        value: [],
        '@odata.nextLink': `${GRAPH_FIXTURE_ROOT}/notebooks?$skiptoken=page-${calls + 1}`,
      });
    };
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch, {
      limits: { maxPaginationPages: 1 },
    }));
    await expect(client.acquire()).rejects.toMatchObject({ code: 'limit-exceeded', operation: 'list-notebooks' });
    expect(calls).toBe(1);
  });

  it('surfaces caller cancellation as an opaque aborted diagnostic', async () => {
    const controller = new AbortController();
    const fetch: GraphFetch = async (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('details must not escape', 'AbortError')), { once: true });
    });
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch));
    const pending = client.acquire({ signal: controller.signal });
    controller.abort('private cancellation reason');

    await expect(pending).rejects.toMatchObject({
      name: 'OneNoteGraphAcquisitionError', code: 'aborted', operation: 'list-notebooks',
    });
    await expect(pending).rejects.not.toHaveProperty('message', expect.stringContaining('private cancellation reason'));
  });

  it('aborts an unresponsive request at the configured timeout', async () => {
    const fetch: GraphFetch = async (_input, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
    });
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch, { requestTimeoutMs: 5 }));
    await expect(client.acquire()).rejects.toMatchObject({ code: 'timeout', operation: 'list-notebooks' });
  });

  it('rejects cross-origin continuation links without sending a token', async () => {
    const calls: string[] = [];
    const fetch: GraphFetch = async (input) => {
      calls.push(input);
      return json({
        value: [],
        '@odata.nextLink': 'https://attacker.invalid/v1.0/me/onenote/notebooks?$skiptoken=stolen',
      });
    };
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch));
    await expect(client.acquire()).rejects.toMatchObject({ code: 'unsafe-url', operation: 'list-notebooks' });
    expect(calls).toHaveLength(1);
  });

  it('does not fetch malicious page resource URLs and reports the lost image', async () => {
    const fetch = vi.fn(minimalHierarchyFetch('<img src="https://attacker.invalid/image.png" alt="blocked">'));
    const client = createMicrosoftGraphOneNoteClient(testOptions(fetch));
    const result = await client.acquirePreview({ preview: { createdAt: '2026-08-03T13:00:00Z' } });

    expect(result.input.resources).toEqual([]);
    expect(result.preview.pageReports).toMatchObject([{
      pageId: 'page', status: 'unsupported', issues: [expect.objectContaining({ code: 'image-resource-missing' })],
    }]);
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/resources/'))).toBe(false);
  });

  it('rejects an oversized resource before reading its body', async () => {
    const pageHtml = '<object data="https://graph.microsoft.com/v1.0/me/onenote/resources/large/content" data-attachment="large.bin" type="application/octet-stream">';
    const oversized = new Response(new Uint8Array([1]).buffer as ArrayBuffer, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': '11' },
    });
    const client = createMicrosoftGraphOneNoteClient(testOptions(
      minimalHierarchyFetch(pageHtml, oversized),
      { limits: { maxResourceBytes: 10 } },
    ));
    await expect(client.acquire()).rejects.toMatchObject({ code: 'limit-exceeded', operation: 'get-resource-content' });
  });
});

describe('Graph HTML resource reference extraction', () => {
  it('ignores executable payloads and foreign, credentialed, or query-bearing URLs', () => {
    const references = extractGraphResourceReferences(`
      <script><img src="https://graph.microsoft.com/v1.0/me/onenote/resources/script/content"></script>
      <!-- <img src="https://graph.microsoft.com/v1.0/me/onenote/resources/comment/content"> -->
      <img data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/safe/$value" />
      <img src="https://user:secret@graph.microsoft.com/v1.0/me/onenote/resources/credential/content" />
      <object data="https://www.onenote.com/api/v1.0/me/notes/resources/file/$value?redirect=1"></object>
      <img src="https://attacker.invalid/v1.0/me/onenote/resources/foreign/content" />
    `);
    expect(references).toEqual([{ id: 'safe', kind: 'image', mediaTypeHint: undefined, fileName: undefined }]);
  });
});
