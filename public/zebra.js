import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfToZpl, testZpl, saveMediaZpl, CALIBRATE_ZPL, CANCEL_ZPL } from '../src/zebra.js';
// The saved label PDF is drawn here at the printer's 203 dpi and sent to the Zebra as ZPL, bypassing the driver's page settings.
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
window.mawaidZebra = {
  pdfToZpl: (bytes, settings) => pdfToZpl(pdfjs, bytes, settings, { standardFontDataUrl: '/vendor/standard_fonts/' }),
  testZpl, saveMediaZpl, CALIBRATE_ZPL, CANCEL_ZPL
};
