import { useEffect, useRef, useState } from 'react';
import { FileText, NotebookPen } from 'lucide-react';
import { inkRasterStore, type InkRasterRecord } from '../editor/inkRasterStore';

/**
 * A small picture of a page for the start screen: the stored picture of its
 * handwriting (editor/inkRaster.ts keeps one per page this device opened) on
 * the page's paper colour, cut to the top of the page. Pages without one show
 * a quiet icon. The picture loads when the card scrolls into view.
 */

interface Loaded {
  record: InkRasterRecord;
  url: string;
}

const cache = new Map<string, Promise<Loaded | null>>();

function loadThumbnail(pageId: string, updatedAt: string): Promise<Loaded | null> {
  const key = `${pageId}@${updatedAt}`;
  let entry = cache.get(key);
  if (!entry) {
    const store = inkRasterStore();
    entry = store
      ? store.load(pageId).then((record) => (record ? { record, url: URL.createObjectURL(record.blob) } : null)).catch(() => null)
      : Promise.resolve(null);
    cache.set(key, entry);
  }
  return entry;
}

export function PageThumbnail({
  pageId,
  updatedAt,
  markdown,
  paper,
}: {
  pageId: string;
  updatedAt: string;
  markdown?: boolean;
  /** Width of the page area shown, in page units. */
  paper?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    let active = true;
    const start = () => {
      void loadThumbnail(pageId, updatedAt).then((result) => {
        if (active) setLoaded(result);
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [pageId, updatedAt]);

  const record = loaded?.record;
  // The picture covers `bounds` (page units) of the page's first screen; the
  // card shows the page from its corner, as wide as the page area given.
  const width = Math.max(record ? record.bounds.x + record.bounds.width : 1, paper ?? 420);
  return (
    <div ref={ref} className="m-thumb" style={record ? { background: record.paper.color } : undefined} aria-hidden="true">
      {record && loaded ? (
        <img
          src={loaded.url}
          alt=""
          draggable={false}
          style={{
            left: `${(record.bounds.x / width) * 100}%`,
            top: `${(record.bounds.y / width) * 100}cqw`,
            width: `${(record.bounds.width / width) * 100}%`,
          }}
        />
      ) : (
        <span className="m-thumb__icon">{markdown ? <FileText size={20} /> : <NotebookPen size={20} />}</span>
      )}
    </div>
  );
}
