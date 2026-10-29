export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio in a row of areas summing to `sum`, laid along a side of length `side`. */
const worst = (sum: number, max: number, min: number, side: number) =>
  Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk): splits `rect` into
 * one box per value, each sized by its share, keeping boxes close to square
 * so their labels fit. `values` must be sorted biggest first.
 */
export function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const areas = values.map((v) => Math.max(v * scale, 1e-9));
  const out: Rect[] = [];
  let { x, y, w, h } = rect;

  let i = 0;
  while (i < areas.length) {
    // Grow the row while that makes its boxes more square.
    const side = Math.min(w, h);
    let sum = areas[i];
    let max = areas[i];
    let min = areas[i];
    let score = worst(sum, max, min, side);
    let end = i + 1;
    while (end < areas.length) {
      const a = areas[end];
      const next = worst(sum + a, Math.max(max, a), Math.min(min, a), side);
      if (next > score) break;
      sum += a;
      max = Math.max(max, a);
      min = Math.min(min, a);
      score = next;
      end++;
    }

    // Lay the row along the short side, then carry on in what's left.
    if (w >= h) {
      const cw = Math.min(sum / h, w);
      let yy = y;
      for (let k = i; k < end; k++) {
        const bh = areas[k] / cw;
        out.push({ x, y: yy, w: cw, h: bh });
        yy += bh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = Math.min(sum / w, h);
      let xx = x;
      for (let k = i; k < end; k++) {
        const bw = areas[k] / rh;
        out.push({ x: xx, y, w: bw, h: rh });
        xx += bw;
      }
      y += rh;
      h -= rh;
    }
    i = end;
  }
  return out;
}
