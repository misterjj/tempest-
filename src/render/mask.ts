// Masque peint d'une zone, écrit directement dans le code du shader.
// Owlbear n'accepte pas de tableaux en uniform : chaque forme devient une ligne de SkSL,
// et le shader est recompilé quand le masque change (rare : seulement quand le MJ peint).

/** Formes d'un masque, en coordonnées de la carte. `erase` : coup de gomme. */
export type Stroke =
  | { k: "circle"; x: number; y: number; r: number; erase?: boolean }
  | { k: "rect"; x: number; y: number; w: number; h: number; erase?: boolean }
  /** Segment de pinceau : un trait est une suite de segments. */
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; r: number; erase?: boolean }
  /** Polygone fermé : points à plat [x0, y0, x1, y1, …] */
  | { k: "poly"; p: number[]; erase?: boolean };

const f = (value: number) => {
  const text = (Math.round(value * 10) / 10).toString();
  return text.includes(".") ? text : `${text}.0`;
};

/** Distance signée à la forme : négative dedans. Un polygone a sa propre fonction, nommée d'après le masque. */
function distance(stroke: Stroke, index: number, name: string) {
  switch (stroke.k) {
    case "poly":
      return `${name}_poly${index}(p)`;
    case "circle":
      return `length(p - vec2(${f(stroke.x)}, ${f(stroke.y)})) - ${f(stroke.r)}`;
    case "rect":
      return `box(p, vec2(${f(stroke.x + stroke.w / 2)}, ${f(stroke.y + stroke.h / 2)}), vec2(${f(Math.abs(stroke.w) / 2)}, ${f(Math.abs(stroke.h) / 2)}))`;
    case "line":
      return `capsule(p, vec2(${f(stroke.x1)}, ${f(stroke.y1)}), vec2(${f(stroke.x2)}, ${f(stroke.y2)}), ${f(stroke.r)})`;
  }
}

function bounds(stroke: Stroke) {
  switch (stroke.k) {
    case "circle":
      return [stroke.x - stroke.r, stroke.y - stroke.r, stroke.x + stroke.r, stroke.y + stroke.r];
    case "rect":
      return [Math.min(stroke.x, stroke.x + stroke.w), Math.min(stroke.y, stroke.y + stroke.h), Math.max(stroke.x, stroke.x + stroke.w), Math.max(stroke.y, stroke.y + stroke.h)];
    case "line":
      return [Math.min(stroke.x1, stroke.x2) - stroke.r, Math.min(stroke.y1, stroke.y2) - stroke.r, Math.max(stroke.x1, stroke.x2) + stroke.r, Math.max(stroke.y1, stroke.y2) + stroke.r];
    case "poly": {
      const xs = stroke.p.filter((_, i) => i % 2 === 0);
      const ys = stroke.p.filter((_, i) => i % 2 === 1);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
}

/**
 * Distance signée à un polygone (méthode d'Inigo Quilez), déroulée arête par arête : SkSL
 * n'accepte pas de tableau de points, chaque polygone a donc sa propre fonction.
 */
export function polygonFunction(points: number[], index: number, name: string) {
  const vertices: [number, number][] = [];
  for (let i = 0; i < points.length; i += 2) vertices.push([points[i], points[i + 1]]);
  const v = (i: number) => `vec2(${f(vertices[i][0])}, ${f(vertices[i][1])})`;
  const edges = vertices
    .map((_, i) => {
      const j = (i + vertices.length - 1) % vertices.length;
      return `  e = ${v(j)} - ${v(i)};
  w = p - ${v(i)};
  b = w - e * clamp(dot(w, e) / max(dot(e, e), 0.0001), 0.0, 1.0);
  d = min(d, dot(b, b));
  c1 = p.y >= ${f(vertices[i][1])};
  c2 = p.y < ${f(vertices[j][1])};
  c3 = e.x * w.y > e.y * w.x;
  if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;`;
    })
    .join("\n");
  return `float ${name}_poly${index}(vec2 p) {
  vec2 e; vec2 w; vec2 b; bool c1; bool c2; bool c3;
  float d = dot(p - ${v(0)}, p - ${v(0)});
  float s = 1.0;
${edges}
  return s * sqrt(d);
}`;
}

/** Fonctions communes à tous les masques d'un même shader. */
export const MASK_HELPERS = `
float box(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float capsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h) - r;
}`;

/**
 * Fonction SkSL `float <name>(vec2 p)` : 1 dans la zone peinte, 0 dehors, avec un fondu de
 * `feather` unités au bord. Sans formes (null) : toute la scène. Plusieurs masques peuvent
 * cohabiter dans un shader, chacun sous son nom (après MASK_HELPERS).
 *
 * Coût mesuré (Apple M4 Pro, zone sur tout l'écran 1920×1080) : environ 0,015 ms par forme,
 * 15 ms pour 1 000 formes. Essayés et plus lents : un découpage en tuiles, et un test de
 * rectangle avant chaque forme (les conditions coûtent plus que les calculs évités). Seul le
 * test du rectangle englobant de toute la zone, au début, fait gagner du temps.
 * Le levier est donc le nombre de formes : voir simplifyStroke.
 */
export function maskFunction(name: string, strokes: Stroke[] | null, feather: number) {
  if (!strokes) return `float ${name}(vec2 p) { return 1.0; }`;
  const painted = strokes.filter((stroke) => !stroke.erase);
  if (!painted.length) return `float ${name}(vec2 p) { return 0.0; }`;
  const margin = Math.max(feather, 0.5);
  const box = painted
    .map(bounds)
    .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const cover = `${name}_cover`;
  const line = (stroke: Stroke, index: number) =>
    stroke.erase
      ? `m = min(m, 1.0 - ${cover}(${distance(stroke, index, name)}));`
      : `m = max(m, ${cover}(${distance(stroke, index, name)}));`;
  return `
${strokes.map((stroke, index) => (stroke.k === "poly" ? polygonFunction(stroke.p, index, name) : "")).filter(Boolean).join("\n")}
float ${cover}(float d) {
  return clamp(0.5 - d / ${f(margin)}, 0.0, 1.0);
}
float ${name}(vec2 p) {
  if (p.x < ${f(box[0] - margin)} || p.y < ${f(box[1] - margin)} || p.x > ${f(box[2] + margin)} || p.y > ${f(box[3] + margin)}) return 0.0;
  float m = 0.0;
${strokes.map((stroke, index) => `  ${line(stroke, index)}`).join("\n")}
  return m;
}`;
}

/** Un seul masque, nommé `mask`, avec ses fonctions communes. */
export const maskSksl = (strokes: Stroke[] | null, feather: number) =>
  `${MASK_HELPERS}\n${maskFunction("mask", strokes, feather)}`;

/**
 * Simplifie un coup de pinceau (Ramer-Douglas-Peucker) : les points qui s'écartent de moins de
 * `tolerance` de la ligne droite sont retirés. Un trait de 100 points en garde une dizaine.
 */
export function simplifyStroke(points: { x: number; y: number }[], tolerance: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy);
  let farthest = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const distance = length
      ? Math.abs(dy * point.x - dx * point.y + last.x * first.y - last.y * first.x) / length
      : Math.hypot(point.x - first.x, point.y - first.y);
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= tolerance) return [first, last];
  return [...simplifyStroke(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyStroke(points.slice(index), tolerance)];
}
