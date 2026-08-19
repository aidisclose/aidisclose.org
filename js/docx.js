// Minimal, dependency-free .docx (OOXML) writer.
//
// Builds a valid Word document as a plain, uncompressed (STORED) ZIP —
// entirely in-browser, with no build step and no third-party library, to
// stay inside the site's CSP (script-src 'self') and its no-third-party-
// request policy. STORED entries make the ZIP layer trivial (no deflate
// implementation needed); Word and LibreOffice read them exactly like
// compressed ones, and a short disclosure statement is a few KB either way.
//
// Scope is deliberately narrow: headings, paragraphs, bold/italic/color
// runs, and simple borderless tables — everything generateWordDoc() in
// index.html needs to mimic \AIDrenderDeclaration's output. It is not a
// general docx library.

(function (global) {
  "use strict";

  // ---------- ZIP (STORED method) ----------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
  function asciiBytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

  // files: [{ name: 'word/document.xml', data: Uint8Array }]
  function makeZip(files) {
    const chunks = [];
    let offset = 0;
    const central = [];

    for (const { name, data } of files) {
      const nameBytes = asciiBytes(name);
      const crc = crc32(data);
      const localHeader = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBytes.length), ...u16(0),
      ]);
      chunks.push(localHeader, nameBytes, data);

      central.push({ nameBytes, crc, size: data.length, offset });
      offset += localHeader.length + nameBytes.length + data.length;
    }

    const centralStart = offset;
    for (const e of central) {
      // file name length, extra length, comment length, disk number,
      // internal attrs are all u16 — but external file attributes is a u32,
      // not a u16. Treating it as a u16 shorted every record by 4 bytes,
      // which cascaded into unreadable garbage from the second entry on.
      const rec = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(e.crc), ...u32(e.size), ...u32(e.size),
        ...u16(e.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(e.offset),
      ]);
      chunks.push(rec, e.nameBytes);
      offset += rec.length + e.nameBytes.length;
    }
    const centralSize = offset - centralStart;

    const eocd = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
      ...u32(centralSize), ...u32(centralStart), ...u16(0),
    ]);
    chunks.push(eocd);

    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // ---------- OOXML helpers ----------

  function escapeXml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]
    ));
  }

  // A single formatted run. `text` may contain \n — each becomes a <w:br/>,
  // matching how a soft line break (not a blank line / new paragraph) looks.
  function run(text, opts) {
    opts = opts || {};
    const rPr = [];
    if (opts.bold) rPr.push("<w:b/>");
    if (opts.italic) rPr.push("<w:i/>");
    if (opts.color) rPr.push(`<w:color w:val="${opts.color}"/>`);
    if (opts.font) rPr.push(`<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}"/>`);
    if (opts.size) rPr.push(`<w:sz w:val="${opts.size}"/>`);
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
    const lines = String(text == null ? "" : text).split("\n");
    const body = lines
      .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
      .join("<w:br/>");
    return `<w:r>${rPrXml}${body}</w:r>`;
  }

  // `content` is a run string, or an array of run strings.
  function para(content, opts) {
    opts = opts || {};
    const pPr = [];
    if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
    if (opts.align) pPr.push(`<w:jc w:val="${opts.align}"/>`);
    if (opts.spacingBefore != null || opts.spacingAfter != null) {
      pPr.push(`<w:spacing${opts.spacingBefore != null ? ` w:before="${opts.spacingBefore}"` : ""}${opts.spacingAfter != null ? ` w:after="${opts.spacingAfter}"` : ""}/>`);
    }
    if (opts.borderBottom) pPr.push(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="auto"/></w:pBdr>`);
    if (opts.keepNext) pPr.push("<w:keepNext/>");
    const pPrXml = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
    const runs = Array.isArray(content) ? content.join("") : content;
    return `<w:p>${pPrXml}${runs}</w:p>`;
  }

  // A borderless grid: rows = [[cellXmlA, cellXmlB, ...], ...]. Cells are
  // paragraph XML (from para()); a falsy cell renders as an empty cell so
  // uneven rows still line up.
  function table(rows, colCount) {
    const gridCols = Array.from({ length: colCount }, () => "<w:gridCol/>").join("");
    const trs = rows
      .map((cells) => {
        const tcs = Array.from({ length: colCount }, (_, i) => {
          const content = cells[i] || para("");
          return `<w:tc><w:tcPr><w:tcMar><w:left w:w="0" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>${content}</w:tc>`;
        }).join("");
        return `<w:tr>${tcs}</w:tr>`;
      })
      .join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>` +
      `<w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/>` +
      `<w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders></w:tblPr>` +
      `<w:tblGrid>${gridCols}</w:tblGrid>${trs}</w:tbl>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="120" w:after="200"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="120" w:after="160"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="27"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="120" w:after="140"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="24"/></w:rPr>
  </w:style>
</w:styles>`;

  function coreProps(title) {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>aidisclose.org</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function documentXml(bodyXml) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr>
  </w:body>
</w:document>`;
  }

  function buildDocxBlob(bodyXml, title) {
    const enc = new TextEncoder();
    const files = [
      { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
      { name: "_rels/.rels", data: enc.encode(PACKAGE_RELS) },
      { name: "docProps/core.xml", data: enc.encode(coreProps(title || "")) },
      { name: "word/document.xml", data: enc.encode(documentXml(bodyXml)) },
      { name: "word/_rels/document.xml.rels", data: enc.encode(DOCUMENT_RELS) },
      { name: "word/styles.xml", data: enc.encode(STYLES) },
    ];
    const zipBytes = makeZip(files);
    return new Blob([zipBytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.AidDocx = { escapeXml, run, para, table, buildDocxBlob, downloadBlob };
})(window);
