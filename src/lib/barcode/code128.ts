/**
 * Code 128 B, rendered as SVG. No dependency, and deliberately so.
 *
 * This runs on a factory server that spends most of the season with no route to the
 * internet. A barcode library is a few hundred lines of table lookup; carrying it as a
 * package would mean the label printer stops working the day `npm ci` cannot reach a
 * registry. The table below is the published Code 128 encodation, and the tests check
 * real symbols against it.
 *
 * Set B covers ASCII 32–126, which is every character a bale serial can contain
 * (`K-2026-101-00042`). Set C would pack the digits two to a symbol and make the label
 * narrower; it is not worth the branch until a label is too wide to print, and none is.
 */

/** Bar/space module widths for values 0–106. Value 106 is the stop pattern. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;

/** The symbol values for `text`, start and checksum included. */
export function code128bValues(text: string): number[] {
  const values = [START_B];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code > 126) {
      throw new Error(`Code 128 B cannot encode ${JSON.stringify(ch)} (U+${code.toString(16)}).`);
    }
    values.push(code - 32);
  }
  // Weighted mod 103: the start value counts once, then position 1, 2, 3…
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += i * values[i]!;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** Module widths across the whole symbol, starting with a bar and alternating. */
export function code128bModules(text: string): number[] {
  return code128bValues(text).flatMap((v) => [...PATTERNS[v]!].map(Number));
}

/**
 * The symbol as an SVG string, ready to drop into a label.
 *
 * Returned as markup rather than as a React element so the same function serves the
 * screen, the print stylesheet and anything that later wants to write a label to a file.
 * `quietZone` is 10 modules by default — the standard's minimum, and the part people
 * trim off when a label looks too wide, which is why scanners then fail on the first and
 * last bar.
 */
export function code128Svg(
  text: string,
  opts: { moduleWidth?: number; height?: number; quietZone?: number } = {},
): string {
  const m = opts.moduleWidth ?? 2;
  const height = opts.height ?? 60;
  const quiet = opts.quietZone ?? 10;

  const modules = code128bModules(text);
  const total = modules.reduce((a, b) => a + b, 0) + quiet * 2;

  const rects: string[] = [];
  let x = quiet;
  let bar = true; // the symbol always starts with a bar
  for (const width of modules) {
    if (bar) {
      rects.push(`<rect x="${x * m}" y="0" width="${width * m}" height="${height}"/>`);
    }
    x += width;
    bar = !bar;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total * m}" height="${height}" ` +
    `viewBox="0 0 ${total * m} ${height}" shape-rendering="crispEdges" fill="#000">` +
    rects.join("") +
    `</svg>`
  );
}
