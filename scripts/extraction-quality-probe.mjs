import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// Owned fixtures only. This is not production instrumentation and takes no user PDF.
for (const file of ['reading-quality.pdf', 'reading-quality-unmapped.pdf']) {
  const pdf = await getDocument({ data: new Uint8Array(await readFile(`tests/fixtures/${file}`)) }).promise
  const page = await pdf.getPage(1)
  const content = await page.getTextContent()
  const text = content.items.filter(i => 'str' in i).map(i => i.str).join(' ')
  if (file.includes('unmapped')) assert.ok(text.includes('\0'))
  else assert.ok(text.includes('f ff fi fl ffi ffl ff fi fl ffi ffl'))
  console.log(JSON.stringify({ ownedFixture: file, rawPdfJsText: text, fonts: Object.values(content.styles).map(s => ({ fontFamily:s.fontFamily })) }))
  await pdf.cleanup()
}
