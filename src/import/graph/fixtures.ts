export const GRAPH_FIXTURE_ROOT = 'https://graph.microsoft.com/v1.0/me/onenote';

export const paginatedNotebookFixture = {
  value: [{
    id: 'notebook-physics',
    displayName: 'Physics 2026',
    createdDateTime: '2026-01-10T09:00:00Z',
    lastModifiedDateTime: '2026-08-01T12:30:00Z',
  }],
  '@odata.nextLink': `${GRAPH_FIXTURE_ROOT}/notebooks?$skiptoken=notebook-page-2`,
};

export const directSectionsFixture = {
  value: [{ id: 'section-mechanics', displayName: 'Mechanics' }],
};

export const rootSectionGroupsFixture = {
  value: [{ id: 'group-labs', displayName: 'Lab work' }],
};

export const groupedSectionsFixture = {
  value: [{ id: 'section-experiments', displayName: 'Experiments' }],
};

export const paginatedPagesFixture = {
  value: [{
    id: 'page-laws',
    title: 'Newton laws',
    order: 1,
    level: 0,
    createdDateTime: '2026-02-01T10:00:00Z',
  }],
  '@odata.nextLink': `${GRAPH_FIXTURE_ROOT}/sections/section-mechanics/pages?pagelevel=true&$skiptoken=page-2`,
};

export const secondPagesFixture = {
  value: [{ id: 'page-diagram', title: 'Force diagram', order: 0, level: 1 }],
};

export const experimentPagesFixture = {
  value: [{ id: 'page-lab', title: 'Pendulum lab', order: 0, level: 0 }],
};

export const pageHtmlFixtures: Record<string, string> = {
  'page-laws': `<!doctype html><html><body>
    <h1>Newton laws</h1>
    <p data-tag="to-do:completed">Review derivation</p>
    <ol><li><strong>Measure</strong> force</li><li>Record acceleration</li></ol>
  </body></html>`,
  'page-diagram': `<!doctype html><html><body>
    <div style="position:absolute;left:120px;top:45px;width:500px">
      <img data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/image-force/$value"
           data-fullres-src-type="image/png" alt="Force diagram" width="420" height="260" />
      <img src="https://attacker.invalid/tracker.png" alt="Blocked remote image" />
    </div>
  </body></html>`,
  'page-lab': `<!doctype html><html><body>
    <table><tr><th>Length</th><th>Period</th></tr><tr><td>1 m</td><td>2 s</td></tr></table>
    <object data="https://www.onenote.com/api/v1.0/me/notes/resources/file-lab/$value"
            data-attachment="pendulum-results.csv" type="text/csv" />
  </body></html>`,
};

export const resourceBodiesFixture: Record<string, { body: Uint8Array; mediaType: string }> = {
  'image-force': { body: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' },
  'file-lab': { body: new TextEncoder().encode('length,period\n1,2\n'), mediaType: 'text/csv' },
};
