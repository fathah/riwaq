// @types/pdf-parse only declares the package root; we import the inner module
// directly to skip pdf-parse's debug bootstrap. Declare that path here.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages: number
    info: unknown
  }
  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>
  export default pdfParse
}
