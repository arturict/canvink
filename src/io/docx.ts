import type { RichTextBlock, RichTextSpan } from '../domain/v2';
import { writeStoredZip, type ZipEntry } from './canvinkBundle';

/**
 * A small WordprocessingML writer for page export. It covers what Canvink
 * pages contain: title, headings, paragraphs with bold/italic/underline/
 * strike/code/links, bullet and numbered lists, to-dos, tables and PNG
 * images. Writing the few XML parts directly keeps the export dependency
 * free; Word, LibreOffice and Google Docs accept the stored (uncompressed)
 * ZIP container.
 */
export type DocxBlock =
  | { kind: 'title'; text: string; subtitle?: string }
  | { kind: 'rich'; block: RichTextBlock }
  | { kind: 'image'; png: Uint8Array; width: number; height: number; description: string }
  | { kind: 'note'; text: string };

const EMU_PER_PIXEL = 9_525;
/** Usable width of an A4 page with 2.5 cm margins, in CSS pixels. */
const MAX_IMAGE_WIDTH = 604;

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

class DocxBuilder {
  private relationships: string[] = [];
  private media: ZipEntry[] = [];
  private orderedLists = 0;
  private numberingInstances: string[] = [];

  private relationship(type: string, target: string, external = false): string {
    const id = `rId${this.relationships.length + 10}`;
    this.relationships.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return id;
  }

  runs(spans: readonly RichTextSpan[]): string {
    return spans.map((span) => {
      const has = (type: RichTextSpan['marks'][number]['type']) => span.marks.some((mark) => mark.type === type);
      const properties = [
        has('bold') ? '<w:b/>' : '',
        has('italic') ? '<w:i/>' : '',
        has('underline') ? '<w:u w:val="single"/>' : '',
        has('strike') ? '<w:strike/>' : '',
        has('inlineCode') ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="EEF1EF"/>' : '',
      ].join('');
      const link = span.marks.find((mark) => mark.type === 'link' && mark.href);
      const text = span.text.split('\n').map((line) => `<w:t xml:space="preserve">${xml(line)}</w:t>`).join('<w:br/>');
      const run = (extra: string) => `<w:r>${properties || extra ? `<w:rPr>${extra}${properties}</w:rPr>` : ''}${text}</w:r>`;
      if (link?.href && /^(https?:|mailto:)/i.test(link.href)) {
        const id = this.relationship('hyperlink', link.href, true);
        return `<w:hyperlink r:id="${id}">${run('<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`;
      }
      return run('');
    }).join('');
  }

  paragraph(content: string, properties = ''): string {
    return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${content}</w:p>`;
  }

  private nextOrderedList(): number {
    this.orderedLists += 1;
    const numId = 10 + this.orderedLists;
    this.numberingInstances.push(
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
    );
    return numId;
  }

  image(block: Extract<DocxBlock, { kind: 'image' }>, index: number): string {
    const name = `media/image${index}.png`;
    this.media.push({ path: `word/${name}`, bytes: block.png });
    const id = this.relationship('image', name);
    const scale = Math.min(1, MAX_IMAGE_WIDTH / Math.max(1, block.width));
    const cx = Math.round(block.width * scale * EMU_PER_PIXEL);
    const cy = Math.round(block.height * scale * EMU_PER_PIXEL);
    const description = xml(block.description);
    return this.paragraph(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="Bild ${index}" descr="${description}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      '<w:spacing w:after="160"/>',
    );
  }

  body(blocks: readonly DocxBlock[]): string {
    const parts: string[] = [];
    let imageIndex = 0;
    let orderedNumId: number | null = null;
    for (const entry of blocks) {
      const ordered = entry.kind === 'rich' && entry.block.type !== 'table'
        && entry.block.type !== 'checkItem' && entry.block.list === 'ordered';
      if (!ordered) orderedNumId = null;
      if (entry.kind === 'title') {
        parts.push(this.paragraph(this.runs([{ text: entry.text, marks: [] }]), '<w:pStyle w:val="Title"/>'));
        if (entry.subtitle) parts.push(this.paragraph(this.runs([{ text: entry.subtitle, marks: [] }]), '<w:pStyle w:val="Subtitle"/>'));
      } else if (entry.kind === 'note') {
        parts.push(this.paragraph(`<w:r><w:rPr><w:i/><w:color w:val="65716B"/></w:rPr><w:t xml:space="preserve">${xml(entry.text)}</w:t></w:r>`));
      } else if (entry.kind === 'image') {
        imageIndex += 1;
        parts.push(this.image(entry, imageIndex));
      } else {
        const block = entry.block;
        if (block.type === 'table') {
          parts.push(this.table(block.rows));
        } else if (block.type === 'checkItem') {
          const box = `<w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol"/></w:rPr><w:t xml:space="preserve">${block.checked ? '☑' : '☐'} </w:t></w:r>`;
          parts.push(this.paragraph(box + this.runs(block.spans), '<w:ind w:left="360" w:hanging="360"/>'));
        } else if (block.type === 'heading') {
          const level = Math.min(3, Math.max(1, block.level ?? 1));
          parts.push(this.paragraph(this.runs(block.spans), `<w:pStyle w:val="Heading${level}"/>`));
        } else if (block.list === 'bullet') {
          parts.push(this.paragraph(this.runs(block.spans), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'));
        } else if (block.list === 'ordered') {
          orderedNumId ??= this.nextOrderedList();
          parts.push(this.paragraph(this.runs(block.spans), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${orderedNumId}"/></w:numPr>`));
        } else {
          parts.push(this.paragraph(this.runs(block.spans)));
        }
      }
    }
    return parts.join('');
  }

  table(rows: readonly RichTextSpan[][][]): string {
    if (rows.length === 0) return '';
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const width = Math.floor(9_000 / columns);
    const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('');
    const body = rows.map((row, rowIndex) => {
      const cells = Array.from({ length: columns }, (_, index) => {
        const spans = row[index] ?? [];
        const header = rowIndex === 0;
        const content = this.runs(header
          ? spans.map((span) => ({ ...span, marks: [...span.marks, { type: 'bold' as const }] }))
          : spans);
        return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF1EF"/>' : ''}</w:tcPr>${this.paragraph(content, '<w:spacing w:after="0"/>')}</w:tc>`;
      }).join('');
      return `<w:tr>${rowIndex === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
    }).join('');
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>${this.paragraph('')}`;
  }

  package(blocks: readonly DocxBlock[]): Uint8Array {
    const body = this.body(blocks);
    const encoder = new TextEncoder();
    const part = (path: string, content: string): ZipEntry => ({ path, bytes: encoder.encode(content) });
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${this.relationships.join('')}</Relationships>`;
    return writeStoredZip([
      part('[Content_Types].xml', CONTENT_TYPES),
      part('_rels/.rels', ROOT_RELATIONSHIPS),
      part('word/document.xml', document),
      part('word/_rels/document.xml.rels', relationships),
      part('word/styles.xml', STYLES),
      part('word/numbering.xml', numberingXml(this.numberingInstances)),
      ...this.media,
    ]);
  }
}

export function buildDocx(blocks: readonly DocxBlock[]): Uint8Array {
  return new DocxBuilder().package(blocks);
}

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;

const ROOT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function heading(id: number, size: number, color: string): string {
  return `<w:style w:type="paragraph" w:styleId="Heading${id}"><w:name w:val="heading ${id}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${id === 1 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${id - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-CH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:color w:val="33413B"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="C9CFCB"/></w:pBdr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="8B948F"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>${heading(1, 32, '1E2925')}${heading(2, 28, '1E2925')}${heading(3, 24, '33413B')}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F6FB2"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFC8C2"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

function numberingXml(orderedInstances: readonly string[]): string {
  const level = (format: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${level('bullet', '•')}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="singleLevel"/>${level('decimal', '%1.')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>${orderedInstances.join('')}</w:numbering>`;
}
