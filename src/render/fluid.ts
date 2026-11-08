// Shaders des fluides (lave, eau). La géométrie tracée par le MJ est écrite dans le code, comme
// les masques des zones : le shader n'est recompilé que quand le MJ trace.
//
// Principe : chaque trait donne un repère (s : distance parcourue le long du trait, t : écart à
// son axe). La texture avance le long de s sans jamais se réinitialiser : les plaques de croûte
// et les remous dérivent pour de bon. Autour d'un rocher, les coordonnées suivent l'écoulement
// autour d'un cylindre (potentiel le long, fonction de courant en travers) : les motifs s'écartent
// devant le rocher, le longent et se referment derrière.
//
// Optimisations, du plus au moins rentable :
// - rectangle englobant de la coulée, puis de chaque trait : la plupart des pixels sortent aussitôt ;
// - la texture (le plus cher) n'est calculée que dans la coulée et sa lueur, et seulement pour le
//   trait dominant (le second seulement là où deux traits se rejoignent) ;
// - le bruit des rives et des rochers n'est calculé que près d'un bord ;
// - croûte en cellules de Voronoï sur 4 voisines au lieu de 9 ;
// - octaves du bruit selon la qualité ; traits simplifiés à l'enregistrement.
// Ce fichier ne dépend pas d'Owlbear.

import { FLUID_SHAPES, type Fluid, type FluidKind, type FluidStroke, type Rock } from "../fluids";
import { HEADER } from "./shaders";
import { MASK_HELPERS } from "./mask";
import { PLUGIN_ID } from "../state";
import { RAIN_LAYERS, type Quality } from "../local";
import { rgb } from "./frame";
import type { WantedEffect } from "./sync";


const f = (value: number) => {
  const text = (Math.round(value * 100) / 100).toString();
  return text.includes(".") ? text : `${text}.0`;
};

/** Couleur naturelle de chaque fluide (pour l'eau : la teinte de l'eau profonde). */
export const FLUID_TINTS: Record<FluidKind, { x: number; y: number; z: number }> = {
  lava: { x: 1, y: 0.45, z: 0.1 },
  water: { x: 0.16, y: 0.42, z: 0.5 },
  pool: { x: 0.18, y: 0.45, z: 0.52 },
  // Même teinte que la rivière : la cascade s'y fond.
  waterfall: { x: 0.16, y: 0.42, z: 0.5 },
  shore: { x: 0.25, y: 0.58, z: 0.65 },
  smoke: { x: 0.55, y: 0.64, z: 0.48 },
};

/** Valeur de départ du sélecteur de couleur, par type. */
export const FLUID_COLOR_HINTS: Record<FluidKind, string> = {
  lava: "#ff6a1a",
  water: "#2a6b80",
  pool: "#2e7385",
  waterfall: "#2a6b80",
  shore: "#3a92a6",
  smoke: "#8c9e7a",
};

interface Segment {
  ax: number;
  ay: number;
  ux: number;
  uy: number;
  length: number;
  /** Distance depuis le début du trait, au début du segment */
  walk: number;
}

/**
 * Coordonnées de texture d'un trait : s = s0 + distance × scale le long du trait ; t = écart à
 * l'axe + un décalage qui passe de t0 (début) à t1 (fin). Une branche reprend les coordonnées du
 * bras qu'elle quitte, et arrive sur celles du bras qu'elle rejoint : la texture se raccorde.
 */
interface Mapping {
  s0: number;
  scale: number;
  t0: number;
  t1: number;
  length: number;
  /** Rayon du bras quitté au départ (0 : départ libre), et du bras rejoint à l'arrivée */
  fromHost: number;
  toHost: number;
}

interface PreparedStroke {
  r: number;
  segments: Segment[];
  map: Mapping;
  /** Rectangle englobant, marge comprise */
  box: [number, number, number, number];
  /** Rochers proches, dans le repère du trait */
  rocks: { s: number; t: number; r: number }[];
}

/**
 * Arrondit les virages serrés : dans un coin vif, la rive extérieure est bien plus longue que
 * l'axe, et la texture s'y étale en éventail. Chaque coin de plus de 30° devient une courbe
 * (Bézier quadratique, 2 segments, 4 au-delà de 70°) d'un rayon d'au moins `radius` si la
 * longueur le permet.
 */
export function roundCorners(points: [number, number][], radius: number): [number, number][] {
  if (points.length < 3) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i + 1];
    const inLength = Math.hypot(px - ax, py - ay) || 1;
    const outLength = Math.hypot(bx - px, by - py) || 1;
    const a = [(px - ax) / inLength, (py - ay) / inLength];
    const b = [(bx - px) / outLength, (by - py) / outLength];
    const turn = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
    if (turn < (30 * Math.PI) / 180) {
      out.push(points[i]);
      continue;
    }
    // Longueur des tangentes : celle d'un arc de rayon `radius`, sans dépasser la moitié des segments.
    const tangent = Math.min(radius * Math.tan(turn / 2), inLength * 0.5, outLength * 0.5);
    const start: [number, number] = [px - a[0] * tangent, py - a[1] * tangent];
    const end: [number, number] = [px + b[0] * tangent, py + b[1] * tangent];
    // Chaque segment ajouté coûte à chaque image : 2 suffisent pour un virage modéré.
    const steps = turn > (70 * Math.PI) / 180 ? 4 : 2;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([u * u * start[0] + 2 * u * t * px + t * t * end[0], u * u * start[1] + 2 * u * t * py + t * t * end[1]]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Points d'un trait, virages arrondis. Un trait d'un seul point devient un court segment, pour avoir un sens. */
function pointsOf(stroke: FluidStroke) {
  const points: [number, number][] = [];
  for (let i = 0; i < stroke.p.length; i += 2) points.push([stroke.p[i], stroke.p[i + 1]]);
  if (points.length === 1) points.push([points[0][0] + 1, points[0][1]]);
  return roundCorners(points, stroke.r * 1.3);
}

/** Coordonnées de texture (s, t) d'un point dans un trait déjà préparé, s'il est dans sa largeur. */
function textureAt(stroke: PreparedStroke, x: number, y: number) {
  let best: { distance: number; s: number; t: number } | undefined;
  for (const seg of stroke.segments) {
    const px = x - seg.ax;
    const py = y - seg.ay;
    const h = Math.max(0, Math.min(seg.length, px * seg.ux + py * seg.uy));
    const distance = Math.hypot(px - seg.ux * h, py - seg.uy * h);
    if (!best || distance < best.distance) {
      const along = seg.walk + h;
      const m = stroke.map;
      best = { distance, s: m.s0 + along * m.scale, t: py * seg.ux - px * seg.uy + m.t0 + ((m.t1 - m.t0) * along) / m.length };
    }
  }
  return best && best.distance <= stroke.r ? best : null;
}

/**
 * Repères des traits. Une branche qui part d'un trait déjà tracé (ou y arrive) prend ses
 * coordonnées de texture à cet endroit : la texture ne saute ni à la fourche ni à la jonction.
 * Un trait indépendant reçoit un décalage propre, pour ne pas répéter le motif d'un autre.
 */
function prepare(strokes: FluidStroke[], rocks: Rock[], margin: number): PreparedStroke[] {
  const prepared: PreparedStroke[] = [];
  strokes.forEach((stroke, index) => {
    const points = pointsOf(stroke);
    const segments: Segment[] = [];
    let walked = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const length = Math.hypot(bx - ax, by - ay) || 1;
      segments.push({ ax, ay, ux: (bx - ax) / length, uy: (by - ay) / length, length, walk: walked });
      walked += length;
    }
    const total = Math.max(walked, 1);
    const anchor = (x: number, y: number) => {
      for (const other of prepared) {
        const hit = textureAt(other, x, y);
        if (hit) return { ...hit, r: other.r };
      }
      return null;
    };
    const first = anchor(points[0][0], points[0][1]);
    const last = anchor(points[points.length - 1][0], points[points.length - 1][1]);
    let map: Mapping;
    if (first && last) {
      // Les deux bouts sont fixés : la texture se tasse ou s'étire un peu le long de la branche.
      const scale = Math.min(2, Math.max(0.5, (last.s - first.s) / total));
      map = { s0: first.s, scale, t0: first.t, t1: last.t, length: total, fromHost: first.r, toHost: last.r };
    } else if (first) {
      map = { s0: first.s, scale: 1, t0: first.t, t1: first.t, length: total, fromHost: first.r, toHost: 0 };
    } else if (last) {
      map = { s0: last.s - total, scale: 1, t0: last.t, t1: last.t, length: total, fromHost: 0, toHost: last.r };
    } else {
      map = { s0: index * 1931, scale: 1, t0: index * 577, t1: index * 577, length: total, fromHost: 0, toHost: 0 };
    }
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const pad = stroke.r + margin;
    const self: PreparedStroke = { r: stroke.r, segments, map, box: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad], rocks: [] };
    self.rocks = rocks.flatMap((rock) => {
      const hit = textureAt({ ...self, r: stroke.r + rock.r * 3 }, rock.x, rock.y);
      return hit ? [{ s: hit.s, t: hit.t, r: rock.r * map.scale }] : [];
    });
    prepared.push(self);
  });
  return prepared;
}

/**
 * Confluences : là où une branche quitte un bras ou le rejoint. Le remous se place sur la rive du
 * bras, un peu à l'intérieur ; sa taille suit la plus large des deux.
 */
function confluences(strokes: PreparedStroke[]) {
  const points: { x: number; y: number; r: number; spin: number; stroke: number }[] = [];
  strokes.forEach((stroke, index) => {
    const segs = stroke.segments;
    if (!segs.length) return;
    const first = segs[0];
    const last = segs[segs.length - 1];
    // Point situé à une demi-largeur du bout, dans la branche : là où les eaux se rencontrent.
    const at = (seg: Segment, along: number) => ({ x: seg.ax + seg.ux * along, y: seg.ay + seg.uy * along });
    if (stroke.map.fromHost) {
      const c = at(first, Math.min(first.length, stroke.map.fromHost * 0.9));
      points.push({ ...c, r: Math.max(stroke.r, stroke.map.fromHost) * 1.1, spin: index % 2 ? 1 : -1, stroke: index });
    }
    if (stroke.map.toHost) {
      const c = at(last, Math.max(0, last.length - stroke.map.toHost * 0.9));
      points.push({ ...c, r: Math.max(stroke.r, stroke.map.toHost) * 1.25, spin: index % 2 ? -1 : 1, stroke: index });
    }
  });
  return points;
}

/** Rectangle englobant de toute la coulée, marge comprise. */
function unionBox(strokes: PreparedStroke[]) {
  return strokes.reduce<[number, number, number, number]>(
    (box, stroke) => [Math.min(box[0], stroke.box[0]), Math.min(box[1], stroke.box[1]), Math.max(box[2], stroke.box[2]), Math.max(box[3], stroke.box[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

const outside = (box: [number, number, number, number], p = "p") =>
  `${p}.x < ${f(box[0])} || ${p}.y < ${f(box[1])} || ${p}.x > ${f(box[2])} || ${p}.y > ${f(box[3])}`;

/**
 * Fonctions SkSL du repère de chaque trait : `vec3 <name><k>(vec2 p)` renvoie (s, t, distance).
 * Un segment loin du point (hors de son rectangle élargi de `reach`) est sauté : son poids serait
 * négligeable. C'est ce qui garde le coût bas pour une longue coulée.
 */
function frameFunctions(strokes: PreparedStroke[], name: string, margin: number) {
  return strokes
    .map(
      (stroke, k) => `
vec3 ${name}${k}(vec2 p, out vec2 dir) {
  dir = vec2(1.0, 0.0);
  if (${outside(stroke.box)}) return vec3(0.0, 0.0, 1e5);
  float sw = 0.0; float ss = 0.0; float tt = 0.0; float dmin = 1e5; vec2 dd = vec2(0.0); float fade = 0.0;
${stroke.segments
  .map((seg) => {
    const reach = Math.max(stroke.r * 3, stroke.r + margin);
    const bx = seg.ax + seg.ux * seg.length;
    const by = seg.ay + seg.uy * seg.length;
    const box: [number, number, number, number] = [Math.min(seg.ax, bx) - reach, Math.min(seg.ay, by) - reach, Math.max(seg.ax, bx) + reach, Math.max(seg.ay, by) + reach];
    return `  if (!(${outside(box)})) {
    vec2 pa = p - vec2(${f(seg.ax)}, ${f(seg.ay)});
    vec2 u = vec2(${seg.ux.toFixed(4)}, ${seg.uy.toFixed(4)});
    // La distance parcourue continue au-delà des bouts du segment (hr) : bloquée au bout, elle
    // serait la même sur tout un éventail, et la texture s'y étirerait (bouts de trait, virages).
    float hr = dot(pa, u);
    float h = clamp(hr, 0.0, ${f(seg.length)});
    vec2 off = pa - u * h;
    float dist = length(off);
    dmin = min(dmin, dist);
    // Les segments proches comptent plus : pas de cassure aux jointures. Plus loin (la lueur
    // autour de la lave), seule la distance sert.
    if (dist < ${f(stroke.r * 2.5)}) {
      float q = dist * ${(1 / stroke.r).toFixed(5)};
      float w = 1.0 / (q * q * q * q + 0.02);
      float along = ${f(seg.walk)} + hr;
      ss += (${f(stroke.map.s0)} + along * ${stroke.map.scale.toFixed(4)}) * w;
      tt += (pa.y * u.x - pa.x * u.y + ${f(stroke.map.t0)} + along * ${((stroke.map.t1 - stroke.map.t0) / stroke.map.length).toFixed(5)}) * w;
      sw += w; dd += u * w;${
        stroke.map.fromHost || stroke.map.toHost
          ? `
      // Dans le bras quitté ou rejoint, la branche s'efface : c'est lui qui donne la texture.
      // Effacée dès la rive du bras (au-delà d'environ un rayon du bout) ; au carré, car près de son
      // axe la branche pèse bien plus que le bras.
      float fd = ${stroke.map.fromHost ? `smoothstep(${f(stroke.map.fromHost * 0.5)}, ${f(stroke.map.fromHost * 1.4)}, along)` : "1.0"} * ${
        stroke.map.toHost ? `smoothstep(${f(stroke.map.toHost * 0.5)}, ${f(stroke.map.toHost * 1.4)}, ${f(stroke.map.length)} - along)` : "1.0"
      };
      fade += fd * fd * w;`
          : ""
      }
    }
  }`;
  })
  .join("\n")}
  if (sw <= 0.0) return vec3(0.0, 0.0, dmin);
  // Sens du courant à cet endroit (éclairage du relief) ; sa longueur porte la présence du trait.
  dir = dd / max(length(dd), 0.0001) * ${stroke.map.fromHost || stroke.map.toHost ? "max(fade / sw, 0.001)" : "1.0"};
  return vec3(ss / sw, tt / sw, dmin);
}`,
    )
    .join("\n");
}

/** Coordonnées qui contournent les rochers du trait k (écoulement autour d'un cylindre). */
function aroundFunctions(strokes: PreparedStroke[]) {
  return strokes
    .map(
      (stroke, k) => `
vec2 around${k}(vec2 st) {
  vec2 o = st;
${stroke.rocks
  .map(
    (rock) => `  {
    vec2 rel = st - vec2(${f(rock.s)}, ${f(rock.t)});
    float r2 = max(dot(rel, rel), ${f(rock.r * rock.r)});
    // Influence limitée aux abords du rocher : au-delà, le courant reprend son cours.
    float k = ${f(rock.r * rock.r)} / r2 * (1.0 - smoothstep(${f(rock.r * 1.4)}, ${f(rock.r * 3.5)}, sqrt(r2)));
    // Déviation adoucie : la pleine formule écrase les motifs contre le rocher.
    o += vec2(rel.x * k, -rel.y * k) * 0.6;
  }`,
  )
  .join("\n")}
  return o;
}`,
    )
    .join("\n");
}

/** Distance signée aux rochers (négative dedans), au bord un peu irrégulier. */
function rockCode(rocks: Rock[]) {
  return rocks
    .map(
      (rock, index) => `
  {
    vec2 rel = p - vec2(${f(rock.x)}, ${f(rock.y)});
    float rl = length(rel);
    float R = ${f(rock.r)};
    // Bord irrégulier, calculé seulement près du rocher.
    if (rl < R * 1.3) R *= 1.0 + 0.18 * (vnoise(rel / max(rl, 0.001) * 2.0 + ${f(index * 7.3)}) - 0.5);
    dRock = min(dRock, rl - R);
  }`,
    )
    .join("");
}

const COMMON = `
uniform float speed;
uniform float opacity;
uniform float layers;
uniform vec3 tint;
uniform float custom;
// Cellules de Voronoï sur les 4 voisines les plus proches : x, distance au centre ; y, au bord.
vec2 cells(vec2 x) {
  vec2 n = floor(x);
  vec2 fr = fract(x);
  vec2 base = n + step(0.5, fr) - 1.0;
  float d1 = 8.0;
  float d2 = 8.0;
  for (int k = 0; k < 4; k++) {
    vec2 g = base + vec2(float(k - (k / 2) * 2), float(k / 2));
    vec2 r = g + vec2(rnd(g), rnd(g + 17.3)) - x;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return vec2(sqrt(d1), sqrt(d2) - sqrt(d1));
}
`;

const LAVA = `
uniform float o_crust;
uniform float o_glow;
vec3 ramp(float t) {
  vec3 c = mix(vec3(0.05, 0.02, 0.02), vec3(0.45, 0.04, 0.0), smoothstep(0.0, 0.3, t));
  c = mix(c, vec3(0.95, 0.25, 0.0), smoothstep(0.25, 0.55, t));
  c = mix(c, vec3(1.0, 0.62, 0.08), smoothstep(0.5, 0.8, t));
  return mix(c, vec3(1.0, 0.95, 0.7), smoothstep(0.78, 1.0, t));
}
// Hauteur de la croûte : des plaques bombées, qui descendent vers les fissures.
float crustHeight(vec2 q, float n) {
  float slow = clock() * 0.03;
  vec2 cell = cells(q * 0.9 + vec2(n * 0.8));
  float plates = smoothstep(0.62 - 0.4 * o_crust, 0.82 - 0.4 * o_crust, fbm(q * 0.3 + vec2(3.1, slow), 2.0));
  return plates * smoothstep(0.02, 0.22, cell.y);
}
// Texture en coordonnées du courant (x : le long, y : en travers), en cases : température, croûte, filets.
vec3 tex(vec2 q) {
  float slow = clock() * 0.03;
  float n = fbm(q * 0.6 + vec2(0.0, slow), layers + 1.0);
  float streak = smoothstep(0.55, 0.85, fbm(vec2(q.x * 0.3, q.y * 1.1) + vec2(n * 0.6, slow), layers + 1.0));
  return vec3(n, crustHeight(q, n), streak);
}
// Relief éclairé : pente de la croûte vers la lumière (positive : face éclairée).
float relief(vec2 q, vec2 lq, float n) {
  float eps = 0.05;
  return (crustHeight(q - lq * eps, n) - crustHeight(q + lq * eps, n)) / (2.0 * eps);
}
`;

const WATER = `
uniform float o_foam;
uniform float o_clarity;
// Rides de la surface : étirées dans le sens du courant.
float rippleAt(vec2 q, float n) {
  float slow = clock() * 0.05;
  return fbm(vec2(q.x * 0.5, q.y * 2.2) + vec2(n * 0.8, slow * 2.0), layers + 1.0);
}
// Texture en coordonnées du courant : rides, écume, reflets.
vec3 tex(vec2 q) {
  float slow = clock() * 0.05;
  float n = fbm(q * 0.8 + vec2(0.0, slow), layers + 1.0);
  float froth = fbm(q * 1.8 + vec2(n, -slow), layers);
  return vec3(n, rippleAt(q, n), froth);
}
// Pente des rides vers la lumière.
float relief(vec2 q, vec2 lq, float n) {
  float eps = 0.04;
  return (rippleAt(q - lq * eps, n) - rippleAt(q + lq * eps, n)) / (2.0 * eps);
}
`;

/** Rendu de la lave à partir de la texture et des distances (d : au bord, négatif dedans). */
const LAVA_SHADE = `
  float depth = clamp(-d / (unit * 1.4), 0.0, 1.0);
  float rim = exp(d / (unit * 0.18)) * step(d, 0.0) * (0.4 + 0.6 * o_glow);
  float temp = 0.35 + 0.35 * depth + 0.4 * (tx.x - 0.5) + 0.25 * fast + 0.45 * tx.z + 0.3 * rim + 0.32 * eddy - 0.08 * conf * (1.0 - eddy) + 0.45 * srcFoam + 0.25 * srcRing + srcJet;
  // La croûte se forme au bord et là où ça ralentit ; elle casse dans le courant rapide.
  // Dans le courant rapide et au milieu, les plaques rétrécissent (au lieu de pâlir) : bords nets.
  float crustLevel = 0.12 + 0.55 * fast + 0.3 * smoothstep(0.4, 1.0, depth);
  float crustHere = smoothstep(crustLevel, crustLevel + 0.06, tx.y);
  vec3 col = ramp(clamp(temp, 0.0, 1.0));
  // Croûte de basalte refroidi, en relief : face éclairée plus claire, l'autre dans l'ombre, et un
  // reflet rouge de la lave sur ses bords bas.
  // Le relief (deux calculs de croûte de plus) seulement là où il y a de la croûte.
  float slope = crustHere > 0.001 && layers > 1.5 ? clamp(relief(q0, lq, tx.x) * 0.35, -1.0, 1.0) : 0.0;
  // Surface rugueuse : grain fin et bosses, qui accrochent la lumière.
  float grit = vnoise(q0 * 7.0) * 0.6 + vnoise(q0 * 17.0) * 0.4;
  vec3 basalt = mix(vec3(0.06, 0.05, 0.045), vec3(0.26, 0.22, 0.2), tx.x * 0.6 + grit * 0.4);
  basalt *= 0.7 + 1.1 * max(slope, 0.0) - 0.35 * max(-slope, 0.0);
  basalt += vec3(0.55, 0.1, 0.0) * (1.0 - smoothstep(0.1, 0.6, tx.y)) * (0.5 + 0.5 * temp);
  // La lave liquide a aussi un léger modelé (filets plus clairs, creux plus sombres).
  col *= 0.92 + 0.16 * tx.z;
  // Peau de refroidissement : de fins plis sombres sur la lave liquide, moins dans le courant chaud.
  if (temp < 0.85 && crustHere < 0.999 && layers > 1.5) {
    float ridge = 1.0 - abs(2.0 * fbm(vec2(q0.x * 0.9, q0.y * 2.0) + tx.x * 1.5, 2.0) - 1.0);
    float skin = smoothstep(0.7, 0.95, ridge) * (1.0 - smoothstep(0.5, 0.85, temp)) * smoothstep(0.3, 0.7, vnoise(q0 * 0.7 + 9.0));
    col = mix(col, col * vec3(0.55, 0.38, 0.3), skin * 0.55);
  }
  col = mix(col, basalt, crustHere);
  // Couleur choisie : même lumière, autre teinte ; le plus chaud reste presque blanc.
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  col = mix(col, mix(tint * lum * 2.2, vec3(1.0, 0.97, 0.9), smoothstep(0.85, 1.0, temp)), custom);
  float inside = 1.0 - smoothstep(-unit * 0.06, unit * 0.06, d);
  // Lueur sur le sol autour de la coulée.
  float glowOut = exp(-max(d, 0.0) / (unit * 0.35)) * o_glow;
  vec3 glowColor = mix(vec3(1.0, 0.35, 0.05), tint, custom);
  float a = (inside + glowOut * 0.45 * (1.0 - inside)) * opacity;
  return half4(half3(col * inside + glowColor * glowOut * 0.55 * (1.0 - inside)) * half(opacity), half(a));
`;

/** Rendu de l'eau : plus sombre au milieu, rides claires, écume aux rives et aux rochers. */
const WATER_SHADE = `
  float depth = clamp(-d / (unit * 1.2), 0.0, 1.0);
  vec3 col = mix(tint * 1.25 + 0.06, tint * 0.55, depth);
  col += (tx.x - 0.5) * 0.08 * (0.6 + 0.4 * depth);
  // Rides en relief : les pentes tournées vers la lumière s'éclaircissent, et les plus raides
  // renvoient le ciel (reflet blanc).
  // Qualité basse : pas de relief (deux calculs de rides de plus).
  float slope = layers > 1.5 ? relief(q0, lq, tx.x) : 0.0;
  col *= 0.88 + 0.3 * clamp(slope * 0.35, -1.0, 1.0);
  float sky = smoothstep(1.2, 2.6, slope) * 0.55;
  // Au fond, là où l'eau est claire et peu profonde : la lumière ondule (caustiques).
  vec2 cq = q0 * vec2(1.1, 1.6);
  float c1 = vnoise(cq + vec2(clock() * 0.35, 0.0));
  float c2 = vnoise(cq * 1.3 + vec2(0.0, clock() * 0.3) + 5.0);
  float caustic = pow(1.0 - abs(c1 - c2), 12.0) * (1.0 - depth) * (0.3 + 0.7 * o_clarity);
  col += vec3(0.8, 0.95, 0.9) * caustic * 0.4;
  // Écume : le long des rives, devant et derrière les rochers, et là où ça va vite.
  float bank = 1.0 - smoothstep(0.0, unit * 0.45, -d);
  float churn = clamp(bank * 0.7 + fast * 1.3, 0.0, 1.0) * o_foam;
  float foam = smoothstep(0.62, 0.8, tx.z + churn * 0.45) * (0.3 + 0.7 * churn);
  // Écume enroulée dans les remous des confluences.
  foam = max(foam, eddy * (0.35 + 0.45 * tx.z) * (0.4 + 0.6 * o_foam));
  // Liseré d'écume contre la rive, festonné par les remous.
  foam = max(foam, (1.0 - smoothstep(0.0, unit * (0.06 + 0.1 * tx.z), -d)) * 0.75 * o_foam);
  // Sources : écume du bouillon, rides, jet.
  foam = max(foam, srcFoam * (0.45 + 0.55 * o_foam));
  col += srcRing * 0.16;
  // Reflets qui scintillent.
  float glint = pow(vnoise(vec2(q0.x * 0.9, q0.y * 3.0) * 3.0 + clock() * 0.8), 12.0) * 0.6;
  col = mix(col, vec3(0.95, 0.98, 1.0), clamp(foam + glint + sky, 0.0, 1.0));
  float inside = 1.0 - smoothstep(-unit * 0.08, unit * 0.04, d);
  // Peu profonde au bord : on y voit le fond.
  float body = mix(0.55, 0.97, depth) * (1.0 - 0.4 * o_clarity) + 0.05;
  col = mix(col, vec3(0.97, 0.99, 1.0), srcJet);
  float a = clamp(max(max(body, foam * 0.9), srcJet), 0.0, 1.0) * inside * opacity;
  return half4(half3(col) * half(a), half(a));
`;

const WATERFALL = `
uniform float o_boil;
uniform float o_foam;
uniform float o_mist;
// Eau qui tombe : longs filets étirés dans le sens de la chute, et bouillons d'écume.
vec3 tex(vec2 q) {
  float slow = clock() * 0.08;
  float n = fbm(q * 0.7 + vec2(0.0, slow), layers + 1.0);
  // Filets fins et serrés : bruit « en arêtes », très étiré dans le sens de la chute.
  float ridge = 1.0 - abs(2.0 * fbm(vec2(q.x * 0.1, q.y * 4.5) + vec2(n * 0.3, 0.0), layers + 1.0) - 1.0);
  float streak = ridge * ridge;
  float froth = fbm(q * 1.6 + vec2(n, -slow), layers);
  return vec3(n, streak, froth);
}
float relief(vec2 q, vec2 lq, float n) { return 0.0; }
`;

const WATERFALL_SHADE = `
  // Le trait suit la lèvre : l'amont à sa gauche (u < 0), la chute et son pied à sa droite (u > 0).
  // La cascade se pose sur l'eau d'une rivière ou d'un bassin : elle s'y fond en amont et en aval.
  float ts = clock() * speed;
  vec2 g = vec2(sRaw, tRaw) / unit;
  // La lèvre n'est jamais une ligne droite : elle ondule le long du trait, et bouge un peu.
  float lipWave = (fbm(vec2(g.x * 0.7, ts * 0.12), 3.0) - 0.5) * 0.1;
  float u = tRaw / rr + lipWave;
  float wobble = fbm(vec2(g.x * 0.9, ts * 0.2), 3.0) - 0.5;
  // Longueur visible de la nappe vue d'en haut (raccourcie), et son pied irrégulier.
  float sheetEnd = 0.34 + wobble * 0.12;
  // Passages larges : aucun changement brusque entre l'amont, la nappe et le pied.
  // La nappe ne s'efface pas en bas : c'est le pied qui la recouvre (sinon l'eau sombre de
  // l'amont réapparaîtrait entre les deux, en une ligne).
  float sheet = smoothstep(-0.04, 0.05, u);
  float upstream = 1.0 - smoothstep(-0.04, 0.05, u);
  vec3 water = tint * (0.82 + 0.3 * fbm(g * 0.6 + vec2(0.0, ts * 0.05), 3.0)) + 0.03;
  // Amont : l'eau accélère vers la lèvre ; des reflets étirés apparaissent.
  float accel = smoothstep(-0.7, 0.0, u);
  float glide = fbm(vec2(g.x * 2.2, g.y * 0.3 - ts * 2.2), 3.0);
  // Seuls les reflets se posent sur la rivière : son eau reste visible dessous.
  float shine = smoothstep(0.5, 0.85, glide) * accel;
  vec3 col = mix(water * 0.8, vec3(0.85, 0.95, 1.0), shine * 0.7);
  float a = upstream * accel * (0.25 + 0.5 * shine);
  // Lèvre : un bourrelet clair, large et irrégulier (plus brillant par endroits), pas un trait.
  float lipVar = 0.35 + 0.65 * smoothstep(0.25, 0.75, vnoise(vec2(g.x * 1.6, ts * 0.3)));
  float lip = exp(-pow(u / 0.07, 2.0)) * lipVar;
  col = mix(col, mix(water, vec3(0.9, 0.97, 1.0), 0.6), lip * (0.6 + 0.4 * glide));
  a = max(a, lip * 0.8);
  // Nappe : filets doux et serrés qui défilent vers le bas, de plus en plus blancs.
  float sp = clamp(u / max(sheetEnd, 0.01), 0.0, 1.0);
  // Filets nets (fins et larges mêlés) ; entre eux, l'eau sombre donne la profondeur de la chute.
  // Vue d'en haut, la nappe passe du verre sombre au blanc en tombant ; les filets ne font que
  // la nuancer (trop marqués, ils font un code-barres).
  float strands = vnoise(vec2(g.x * 5.0, g.y * 0.3 - ts * 3.0)) * 0.6 + vnoise(vec2(g.x * 13.0, g.y * 0.5 - ts * 4.5)) * 0.4;
  // Le bas de la nappe se brise en embruns blancs : elle se fond dans le bouillon.
  float whiteness = clamp(0.1 + sp * 0.75 + (strands - 0.5) * 0.5 + smoothstep(0.6, 1.0, sp) * 0.45, 0.0, 1.0);
  vec3 sheetCol = mix(water * mix(0.75, 0.55, sp), vec3(0.95, 0.98, 1.0), whiteness);
  col = mix(col, sheetCol, sheet);
  a = mix(a, 0.92, sheet);
  // Pied : un bouillon d'écume qui s'étale vers l'aval en se déchirant.
  float dist = max(u - sheetEnd, 0.0);
  vec2 fg = vec2(g.x, g.y - ts * 0.7);
  vec2 warp = vec2(fbm(fg * 0.6 + vec2(ts * 0.1, 0.0), 2.0), fbm(fg * 0.6 + vec2(3.1, -ts * 0.1), 2.0)) - 0.5;
  float foamN = fbm(fg * 1.4 + warp * 1.8, 4.0);
  // Pied : entrée progressive et déchiquetée, jamais une ligne.
  float downstream = smoothstep(sheetEnd - 0.1, sheetEnd + 0.06, u + (foamN - 0.5) * 0.2);
  // Juste au pied, l'écume est presque continue ; elle se déchire en s'éloignant.
  // Le réglage Écume va d'un pied presque lisse (0) à un bouillon qui couvre tout (1).
  // Bouillon (au pied) : de presque lisse (0) à un bouillon épais qui s'étend loin (1).
  float thr = 0.18 + dist * mix(1.3, 0.55, o_boil) + (0.55 - o_boil) * 0.3;
  // Le bouillon remonte un peu sur le bas de la nappe, avec un bord déchiqueté.
  float reach = smoothstep(sheetEnd - 0.12, sheetEnd + 0.02, u + (foamN - 0.5) * 0.18);
  float foam = smoothstep(thr, thr + 0.14, foamN) * reach * (0.3 + 0.75 * o_boil);
  // Plus loin, l'écume s'étire en traînées dans le sens du courant (voir plus bas).
  float trail = 0.0;
  // Écume (vers l'aval) : les traînées emportées par le courant.
  // Traînées : chacune a sa longueur et s'effile, se fragmente en dentelle le long du courant, et
  // reste un peu translucide (sinon elles font des rectangles blancs).
  vec2 tg = vec2(g.x * 3.0 + warp.x * 1.2, g.y * 0.35 - ts * 1.3);
  float streaks = fbm(tg, 3.0);
  float lenVar = vnoise(vec2(g.x * 1.3 + warp.y, 7.0 + ts * 0.05));
  float trailLen = (0.45 + 0.75 * o_foam) * (0.5 + 0.8 * lenVar);
  float taper = smoothstep(0.0, 0.06, dist) * (1.0 - smoothstep(trailLen * 0.45, trailLen, dist));
  float lace = smoothstep(0.18, 0.5, fbm(vec2(g.x * 6.0, g.y * 1.6 - ts * 1.3) + warp * 1.5, 3.0));
  float breakup = smoothstep(0.12, 0.45, vnoise(vec2(g.x * 2.5, g.y * 0.9 - ts * 1.3)));
  trail = smoothstep(0.44 - 0.16 * o_foam, 0.62, streaks) * taper * lace * breakup;
  foam = max(foam, trail * (0.55 + 0.4 * o_foam) * step(0.001, o_foam));
  // Juste après l'impact, l'eau reste blanchie ; elle retrouve sa couleur en s'éloignant.
  float settle = smoothstep(0.0, 0.22, dist);
  col = mix(col, water * 0.92, downstream * settle);
  // Relief des bouillons : éclairés d'un côté, ombrés de l'autre.
  float foamLit = fbm(fg * 1.4 + warp * 1.8 + vec2(0.06, 0.08), 4.0) - foamN;
  col = mix(col, vec3(0.95, 0.98, 1.0) * clamp(0.9 - foamLit * 3.0, 0.7, 1.05), clamp(foam, 0.0, 1.0));
  a = mix(a, mix(0.92, 0.55 * (1.0 - smoothstep(0.15, 0.5, dist)), settle), downstream);
  a = max(a, clamp(foam, 0.0, 1.0));
  // Sources posées dans la cascade.
  col = mix(col, vec3(0.96, 0.98, 1.0), clamp(srcFoam * (0.5 + 0.5 * o_foam) + srcJet, 0.0, 1.0));
  col += srcRing * 0.15;
  // Bords latéraux : ceux de la rivière traversée s'il y en a une (clip), sinon le bout du trait.
  float wd = waterDist(p);
  float lateral = (1.0 - smoothstep(-unit * 0.04, unit * 0.04, endOut + (vnoise(p / unit * 2.0) - 0.5) * unit * 0.2)) * (1.0 - smoothstep(-unit * 0.08, unit * 0.04, wd));
  a = clamp(a, 0.0, 1.0) * lateral;
  // Embruns : un nuage à part, qui monte du pied et remonte sur la nappe. Il reste au-dessus de
  // l'eau, et s'estompe juste avant les rives. Le réglage change sa taille et sa densité.
  float mistR = 0.25 + 0.45 * o_mist;
  float fromFoot = u - sheetEnd;
  float mistBand = smoothstep(-mistR * 0.9, 0.0, fromFoot) * (1.0 - smoothstep(mistR * 0.4, mistR * 1.3, fromFoot));
  float mistSide = (1.0 - smoothstep(-unit * 0.3, unit * 0.05, endOut)) * (1.0 - smoothstep(-unit * 0.45, unit * 0.05, wd));
  vec2 mq = p / unit * 0.8 + vec2(ts * 0.15, -ts * 0.35);
  float puffs = fbm(mq + vec2(fbm(mq * 0.7, 2.0), 0.0), 3.0);
  float spray = mistBand * mistSide * smoothstep(0.58 - 0.3 * o_mist, 0.85, puffs) * (0.25 + 0.6 * o_mist) * step(0.001, o_mist);
  // Composé par-dessus l'eau découpée.
  vec3 mistCol = vec3(0.92, 0.96, 1.0);
  vec3 outCol = col * a * (1.0 - spray) + mistCol * spray;
  float outA = a + spray * (1.0 - a);
  return half4(half3(outCol) * half(opacity), half(outA * opacity));
`;

const SMOKE = `
uniform float o_density;
uniform float o_billow;
// Fumée lourde : volutes qui roulent sur elles-mêmes en rampant.
vec3 tex(vec2 q) {
  float slow = clock() * 0.06;
  vec2 warp = vec2(fbm(q * 0.5 + vec2(slow, 0.0), 2.0), fbm(q * 0.5 + vec2(4.1, -slow), 2.0)) - 0.5;
  float n = fbm(q * 0.55 + warp * (0.8 + 1.6 * o_billow), layers + 1.0);
  float puff = fbm(q * 1.2 - warp + vec2(0.0, slow * 2.0), layers);
  return vec3(n, puff, 0.0);
}
float relief(vec2 q, vec2 lq, float n) { return 0.0; }
`;

const SMOKE_SHADE = `
  // Nappe au sol : bords très doux, plus épaisse là où les volutes s'accumulent.
  float inside = 1.0 - smoothstep(-unit * 0.9, unit * 0.5, d);
  float body = smoothstep(0.25, 0.75, tx.x * 0.75 + tx.y * 0.45);
  float thick = inside * (0.2 + 0.8 * body) * (0.3 + 0.7 * o_density);
  // Sources : la fumée en déborde par bouffées qui roulent vers l'extérieur.
  thick = max(thick, srcPuff * (0.7 + 0.3 * o_density));
  // Bouffées fraîches plus claires et plus denses que la nappe.
  vec3 col = tint * (0.7 + 0.45 * tx.y + 0.3 * srcPuff) + vec3(0.04);
  float a = clamp(thick, 0.0, 1.0) * 0.85 * opacity;
  return half4(half3(col) * half(a), half(a));
`;

/** Rivage : vagues qui montent sur la plage, se brisent en écume et se retirent. */
const SHORE_SHADE = `
  // x : 1 côté mer, -1 côté terre (la mer est à gauche du sens du tracé).
  float x = -tRaw / rr;
  if (abs(x) > 1.3) return half4(0.0);
  float s = sRaw / unit;
  float ph0 = clock() * speed * 0.11;
  float reach = mix(0.05, -0.75, o_waves);
  float foam = 0.0; float film = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float ph = fract(ph0 + fi / 3.0 + 0.25 * vnoise(vec2(s * 0.07, fi * 5.3)));
    // La vague avance vite puis ralentit, et redescend un peu en se retirant.
    float adv = ph < 0.72 ? 1.0 - pow(1.0 - ph / 0.72, 2.0) : 1.0 - (ph - 0.72) / 0.28 * 0.4;
    float front = mix(1.15, reach + 0.25 * (vnoise(vec2(s * 0.25, fi * 3.1)) - 0.5), adv);
    front += 0.05 * sin(s * 0.8 + fi * 2.1 + clock() * 0.4);
    float strength = ph < 0.72 ? smoothstep(0.0, 0.15, ph) : 1.0 - (ph - 0.72) / 0.28;
    float dist = x - front;
    float lace = smoothstep(0.5, 0.78, fbm(vec2(s * 0.7, x * 5.0 - adv * 4.0) + fi * 7.0, 3.0));
    float crest = smoothstep(-0.04, 0.0, dist) * exp(-max(dist, 0.0) * 9.0);
    float trail = step(0.0, dist) * exp(-dist * 2.2) * lace;
    foam = max(foam, (crest * (0.75 + 0.25 * lace) + trail) * strength);
    // Nappe d'eau mince qui recouvre le sable derrière la vague.
    film = max(film, step(0.0, dist) * (1.0 - smoothstep(0.2, 0.9, x)) * strength);
  }
  foam *= 0.4 + o_foam * 1.2;
  // Sable mouillé jusqu'où montent les vagues ; il fond vers la terre.
  float wet = smoothstep(reach - 0.15, reach + 0.05, x) * (1.0 - smoothstep(0.0, 0.5, x));
  // Effilé aux bouts du trait, et doux sur ses deux bords.
  float fade = smoothstep(1.3, 0.9, x) * smoothstep(-1.3, -0.95, x) * (1.0 - smoothstep(0.0, rr * 0.5, endOut + (vnoise(p / unit * 1.5) - 0.5) * rr * 0.3));
  vec3 col = vec3(0.12, 0.09, 0.06);
  float a = wet * 0.32;
  col = mix(col, tint * 1.4 + 0.15, film * 0.5);
  a = max(a, film * 0.22);
  col = mix(col, vec3(0.97, 0.98, 1.0), clamp(foam, 0.0, 1.0));
  a = max(a, clamp(foam, 0.0, 1.0) * 0.95);
  a *= fade * opacity;
  return half4(half3(col) * half(a), half(a));
`;

/** Marge autour de la coulée où il reste quelque chose à dessiner (la lueur de la lave), en cases. */
const MARGIN: Record<FluidKind, number> = { lava: 2, water: 0.2, pool: 0.15, waterfall: 0.4, shore: 0.4, smoke: 0.8 };
/** Irrégularité des rives, de 0 (contour exact) à 1. */
const BANKS: Record<FluidKind, number> = { lava: 1, water: 1, pool: 0, waterfall: 0, shore: 0, smoke: 1.4 };
const TEXTURES: Partial<Record<FluidKind, string>> = { lava: LAVA, water: WATER, pool: WATER, smoke: SMOKE };
const SHADES: Partial<Record<FluidKind, string>> = { lava: LAVA_SHADE, water: WATER_SHADE, pool: WATER_SHADE, smoke: SMOKE_SHADE };
/** Vitesse d'avancée de la texture, en cases par seconde (un bassin dérive à peine). */
const RUN: Partial<Record<FluidKind, number>> = { lava: 0.6, water: 1.6, pool: 0.08, smoke: 0.12, waterfall: 3.5 };

/**
 * Sources : jets, chutes et bouillons ponctuels. Autour de chacune, des rides qui s'élargissent,
 * un bouillon d'écume au point d'impact, et un jet qui retombe en gouttelettes.
 */
function sourceCode(sources: Rock[]) {
  if (!sources.length) return "  float srcFoam = 0.0; float srcRing = 0.0; float srcJet = 0.0; float srcPuff = 0.0;";
  return `  float srcFoam = 0.0; float srcRing = 0.0; float srcJet = 0.0; float srcPuff = 0.0;
  {
    float ts = clock() * speed;
${sources
  .map(
    (src, i) => `    {
      vec2 rel = (p - vec2(${f(src.x)}, ${f(src.y)})) * ${(1 / src.r).toFixed(5)};
      float rs = length(rel);
      if (rs < 1.05) {
        float wob = 0.04 * (vnoise(rel * 5.0 + ${f(i * 3.7)}) - 0.5);
        for (int k = 0; k < 3; k++) {
          float ph = fract(ts * 0.4 + float(k) / 3.0 + ${f((i * 0.37) % 1)});
          float ring = exp(-pow((rs + wob - (0.18 + 0.82 * ph)) / 0.035, 2.0)) * (1.0 - ph);
          srcRing = max(srcRing, ring);
        }
        float churn = fbm(rel * 4.0 + vec2(ts * 0.8, -ts * 0.6) + ${f(i * 9.1)}, 3.0);
        srcFoam = max(srcFoam, smoothstep(0.35, 0.65, churn + (0.3 - rs)) * (1.0 - smoothstep(0.2, 0.45, rs)));
        // Jet : un cœur blanc et des gouttelettes qui retombent tout autour.
        float jet = exp(-rs * rs / 0.006);
        vec2 g = vec2(atan(rel.y, rel.x) * 5.0, rs * 12.0 - ts * 2.5);
        vec2 cell = floor(g);
        float sd = rnd(cell + ${f(i * 13.3)});
        float drop = sd < 0.45 ? (1.0 - smoothstep(0.08, 0.22, length(fract(g) - 0.5))) * (1.0 - smoothstep(0.1, 0.4, rs)) : 0.0;
        srcJet = max(srcJet, clamp(jet + drop * 0.8, 0.0, 1.0));
        // Fumée : bouffées qui naissent au centre et roulent vers l'extérieur en s'effilochant.
        // Au centre, la direction n'a pas de sens : le déplacement s'y annule.
        vec2 outward = rel / max(rs, 0.001) * smoothstep(0.0, 0.35, rs);
        // Motif qui s'éloigne du centre (sans angle : pas de couture ni de rayons).
        float roll = fbm(rel * 2.4 - outward * fract(ts * 0.12) * 2.4 + ${f(i * 5.3)}, 3.0);
        float roll2 = fbm(rel * 2.4 - outward * fract(ts * 0.12 + 0.5) * 2.4 + ${f(i * 5.3 + 11.0)}, 3.0);
        float blend = abs(2.0 * fract(ts * 0.12) - 1.0);
        float puffs = mix(roll, roll2, blend);
        srcPuff = max(srcPuff, smoothstep(0.3, 0.62, puffs + (0.55 - rs) * 0.8) * (1.0 - smoothstep(0.6, 1.0, rs)));
      }
    }`,
  )
  .join("\n")}
  }`;
}

/**
 * Fluides tracés le long d'une ligne (rivage, lèvre d'une cascade) : le courant la traverse, de la
 * gauche du tracé vers sa droite. Repère brut du trait le plus proche : sRaw le long de la ligne,
 * tRaw en travers (négatif à gauche), endOut la distance au-delà des bouts du trait (positive
 * dehors). Rien n'est dessiné loin du trait : sans ce garde-fou, le sable mouillé s'étalait
 * jusqu'au bord du rectangle englobant (des triangles dans les coins).
 */
function lineSksl(strokes: PreparedStroke[], kind: FluidKind, sources: Rock[], clip: string) {
  const raw = strokes.map((stroke) => {
    const pad = stroke.r * 0.45;
    const box: [number, number, number, number] = [stroke.box[0] - pad, stroke.box[1] - pad, stroke.box[2] + pad, stroke.box[3] + pad];
    return { ...stroke, box, map: { ...stroke.map, s0: 0, scale: 1, t0: 0, t1: 0, fromHost: 0, toHost: 0 } };
  });
  const box = unionBox(raw);
  return `${HEADER}${COMMON}${kind === "shore" ? "uniform float o_waves;\nuniform float o_foam;\n" : WATERFALL}
${frameFunctions(raw, "frame", 0)}
${MASK_HELPERS}
${clip}
half4 main(float2 coord) {
  vec2 p = coord;
  if (${outside(box)}) return half4(0.0);
  float tRaw = 0.0; float sRaw = 0.0; float rr = 1.0; float near = 1e5; float endOut = 0.0;
  ${raw
    .map(
      (stroke, k) => `{
    vec2 dir; vec3 fr = frame${k}(p, dir);
    if (fr.z - ${f(stroke.r)} < near) {
      near = fr.z - ${f(stroke.r)}; tRaw = fr.y; sRaw = fr.x; rr = ${f(stroke.r)};
      endOut = max(-sRaw, sRaw - ${f(stroke.map.length)});
    }
  }`,
    )
    .join("\n  ")}
  if (near > rr * 0.35) return half4(0.0);
${sourceCode(sources)}
${kind === "shore" ? SHORE_SHADE : WATERFALL_SHADE}
}`;
}

/** Bouts libres des traits (ni branche ni jonction) : haut et bas d'une cascade, source d'une fumée. */
function freeEnds(strokes: PreparedStroke[]) {
  const starts: { x: number; y: number; r: number; ux: number; uy: number }[] = [];
  const ends: { x: number; y: number; r: number; ux: number; uy: number }[] = [];
  for (const stroke of strokes) {
    const first = stroke.segments[0];
    const last = stroke.segments[stroke.segments.length - 1];
    if (!first) continue;
    if (!stroke.map.fromHost) starts.push({ x: first.ax, y: first.ay, r: stroke.r, ux: first.ux, uy: first.uy });
    if (!stroke.map.toHost) ends.push({ x: last.ax + last.ux * last.length, y: last.ay + last.uy * last.length, r: stroke.r, ux: last.ux, uy: last.uy });
  }
  return { starts, ends };
}

/** Shader d'une coulée. `unitGuess` : taille d'une case, pour les marges (la vraie arrive en uniform). */
/**
 * Découpe d'une cascade : distance signée aux rivières et bassins qu'elle traverse (négative
 * dedans), pour qu'elle prenne leur largeur. Sans eau dessous : rien n'est découpé.
 */
function clipFunction(waters: Fluid[], _unit: number) {
  const lines = waters.flatMap((water) =>
    water.strokes.flatMap((stroke) => {
      const points = pointsOf(stroke);
      return points.slice(1).map((b, k) => ({ a: points[k], b, r: stroke.r, banks: BANKS[water.kind] }));
    }),
  );
  if (!lines.length) return "float waterDist(vec2 p) { return -1e5; }";
  // Même distance et mêmes rives irrégulières que l'eau dessous : les bords coïncident.
  return `float waterDist(vec2 p) {
  float d = 1e5;
${lines.map((l) => `  d = min(d, capsule(p, vec2(${f(l.a[0])}, ${f(l.a[1])}), vec2(${f(l.b[0])}, ${f(l.b[1])}), ${f(l.r)}));`).join("\n")}
  ${lines[0].banks > 0 ? `if (abs(d) < unit * 1.2) d += ((fbm(p / unit * 0.5, 3.0) - 0.5) * unit * 0.9 + (vnoise(p / unit * 3.0) - 0.5) * unit * 0.15) * ${f(lines[0].banks)};` : ""}
  return d;
}`;
}

export function fluidSksl(fluid: Fluid, unitGuess: number, clipTo: Fluid[] = []) {
  const margin = MARGIN[fluid.kind] * unitGuess;
  const strokes = prepare(fluid.strokes, fluid.rocks, margin);
  if (!strokes.length) return null;
  const box = unionBox(strokes);
  // Poids d'un trait : proche de son axe, et effacé dans le bras qu'il quitte ou rejoint (longueur de dir).
  // Là où deux traits se rencontrent, la limite entre leurs textures ondule et bouge : un front de
  // mélange tourbillonnant plutôt qu'une ligne droite.
  const mixing = strokes.length > 1;
  const weight = (k: number) =>
    `float w${k} = length(dir${k}) / (pow(max(fr${k}.z${mixing ? ` + mixFront * ${f(strokes[k].r * 0.9)}` : ""}, 1.0) * ${(1 / strokes[k].r).toFixed(5)}, 6.0) + 0.001); dir${k} = normalize(dir${k});`;
  const { ends } = freeEnds(strokes);
  if (FLUID_SHAPES[fluid.kind] === "line") return lineSksl(strokes, fluid.kind, fluid.sources, clipFunction(clipTo, unitGuess));
  return `${HEADER}${COMMON}${TEXTURES[fluid.kind]}
${frameFunctions(strokes, "frame", margin)}
${aroundFunctions(strokes)}
half4 main(float2 coord) {
  vec2 p = coord;
  if (${outside(box)}) return half4(0.0);
  float dRock = 1e5;
${rockCode(fluid.rocks)}
  ${strokes.map((_, k) => `vec2 dir${k}; vec3 fr${k} = frame${k}(p, dir${k});`).join("\n  ")}
  float dChan = 1e5;
  ${strokes.map((stroke, k) => `dChan = min(dChan, fr${k}.z - ${f(stroke.r)});`).join("\n  ")}
  float d = max(dChan, -dRock);
  if (d > unit * ${f(MARGIN[fluid.kind] + 0.3)}) return half4(0.0);
  // Rives irrégulières : grandes anses et petites dentelures, seulement près du bord.
  // Un bassin suit exactement le contour peint (une vasque dessinée sur la carte, par exemple).
  ${BANKS[fluid.kind] > 0 ? `if (abs(d) < unit * 1.2) d += ((fbm(p / unit * 0.5, 3.0) - 0.5) * unit * 0.9 + (vnoise(p / unit * 3.0) - 0.5) * unit * 0.15) * ${f(BANKS[fluid.kind])};` : ""}
  if (d > unit * ${f(MARGIN[fluid.kind])}) return half4(0.0);
  // Texture du trait dominant, et du second là où deux traits se rejoignent.
  float run = clock() * speed * unit * ${f(RUN[fluid.kind] ?? 1)};
  ${mixing ? "float mixFront = fbm(p / unit * 0.9 + vec2(clock() * 0.15, -clock() * 0.1), 2.0) - 0.5;" : ""}
  ${strokes.map((_, k) => weight(k)).join("\n  ")}
  float wmax = ${strokes.map((_, k) => `w${k}`).reduce((a, b) => `max(${a}, ${b})`)};
  vec3 tx = vec3(0.0); float wsum = 0.0; float fast = 0.0; vec2 q0 = vec2(0.0);
  // Lumière rasante venant du haut à gauche de la carte, exprimée dans le repère du courant.
  vec2 light = vec2(-0.6, -0.8); vec2 lq = vec2(0.0); float wbest = 0.0;
  // Avancée dans le trait dominant, de 0 (début) à 1 (fin) : sert à la cascade.
  float fall = 0.0;
  ${strokes
    .map(
      (stroke, k) => `if (w${k} > wmax * 0.04) {
    vec2 st = around${k}(fr${k}.xy);
    // Resserré entre les rochers : le courant y accélère.
    fast += clamp(length(st - fr${k}.xy) * ${(1 / stroke.r).toFixed(5)}, 0.0, 1.0) * w${k};
    vec2 q = vec2(st.x - run, st.y) / unit;
    if (w${k} > wbest) {
      wbest = w${k}; q0 = q; lq = vec2(dot(light, dir${k}), dot(light, vec2(-dir${k}.y, dir${k}.x)));
      fall = clamp((fr${k}.x - ${f(stroke.map.s0)}) / ${f(stroke.map.length * stroke.map.scale)}, 0.0, 1.0);
    }
    tx += tex(q) * w${k}; wsum += w${k};
  }`,
    )
    .join("\n  ")}
  tx /= wsum; fast /= wsum;
  // Remous aux confluences : un tourbillon qui tourne, dont les bras s'enroulent vers le centre.
  float conf = 0.0; float eddy = 0.0;
  ${(FLUID_SHAPES[fluid.kind] === "area" ? [] : confluences(strokes))
    .map(
      (c, i) => `{
    vec2 rel = (p - vec2(${f(c.x)}, ${f(c.y)})) * ${(1 / c.r).toFixed(5)};
    // Le courant (celui de la branche) emporte le remous : il s'étire vers l'aval.
    vec2 fl = dir${c.stroke};
    vec2 loc = vec2(dot(rel, fl), dot(rel, vec2(-fl.y, fl.x)));
    loc.x = loc.x > 0.0 ? loc.x * 0.55 : loc.x;
    float rr = dot(loc, loc);
    if (rr < 2.5) {
      float k = exp(-rr * 1.6);
      float r1 = sqrt(rr);
      // Peu de tours, bras déchirés par un bruit qui dérive : un remous, pas une spirale dessinée.
      float ang = atan(loc.y, loc.x) * ${f(c.spin)} + r1 * 2.2 - clock() * ${f(0.9 + (i % 3) * 0.2)};
      vec2 polar = vec2(cos(ang), sin(ang)) * (0.7 + r1 * 1.8);
      float arm = fbm(polar + vec2(${f(i * 7.1)}, clock() * 0.1), 3.0);
      float tear = vnoise(rel * 2.3 + vec2(-clock() * 0.6, ${f(i * 3.3)}));
      conf = max(conf, k);
      eddy = max(eddy, smoothstep(0.5, 0.78, arm) * smoothstep(0.25, 0.65, tear) * k);
    }
  }`,
    )
    .join("\n  ")}
  // Eaux agitées : plus d'écume et de croûte brisée, comme dans le courant rapide.
  fast = max(fast, conf * 0.75);
  // Pied d'une cascade : nuage d'embruns.
  float mistCloud = 0.0;
  ${(fluid.kind === "waterfall" ? ends : [])
    .map(
      (e) => `{
    // Le nuage d'embruns déborde vers l'aval.
    vec2 rel = p - vec2(${f(e.x + e.ux * e.r * 0.4)}, ${f(e.y + e.uy * e.r * 0.4)});
    float dd = dot(rel, rel);
    mistCloud = max(mistCloud, exp(-dd / ${f(e.r * e.r * 3.5)}));
  }`,
    )
    .join("\n  ")}
${sourceCode(fluid.sources)}
${SHADES[fluid.kind]}
}`;
}

/**
 * Surimpression du MJ pendant qu'il trace : des chevrons qui défilent dans le sens du courant sur
 * chaque trait, le contour des traits et des rochers. La coulée choisie est en couleur.
 */
export function arrowsSksl(fluids: Fluid[], selected: string | null) {
  const parts = fluids.flatMap((fluid) => {
    // Repère brut (sans les décalages de texture) : t est l'écart réel à l'axe.
    const strokes = prepare(fluid.strokes, [], 0).map((stroke) => ({ ...stroke, map: { ...stroke.map, s0: 0, scale: 1, t0: 0, t1: 0, fromHost: 0, toHost: 0 } }));
    return strokes.map((stroke) => ({ stroke, fluid }));
  });
  if (!parts.length && !fluids.some((fluid) => fluid.sources.length)) return null;
  const prepared = parts.map((part) => part.stroke);
  const rocks = fluids.flatMap((fluid) => fluid.rocks.map((rock) => ({ rock, fluid })));
  return `${HEADER}
${frameFunctions(prepared, "arrow", 0)}
half4 main(float2 coord) {
  vec2 p = coord;
  float line = unit * 0.05;
  float white = 0.0; float dark = 0.0; float lit = 0.0;
  // Seuls les chevrons du trait le plus proche : pas d'enchevêtrement aux fourches.
  float best = 1e5; float arrow = 0.0; float arrowShadow = 0.0; float arrowSel = 0.0;
  ${parts
    .map(({ stroke, fluid }, k) => {
      const spacing = Math.max(stroke.r * 1.4, 40);
      return `{
    vec2 ad;
    vec3 fr = arrow${k}(p, ad);
    if (fr.z < ${f(stroke.r + 4)}) {
      float sel = ${fluid.id === selected ? "1.0" : "0.0"};
      ${
        FLUID_SHAPES[fluid.kind] === "line"
          ? `// Rivage, cascade : les chevrons traversent le trait, de sa gauche vers sa droite.
      float u = fract((fr.y - clock() * unit * 0.5) / ${f(Math.max(stroke.r * 0.6, 24))}) * ${f(Math.max(stroke.r * 0.6, 24))};
      float across = abs(fract(fr.x / ${f(spacing)}) - 0.5) * ${f(spacing)};
      float c = abs(u - ${f(Math.max(stroke.r * 0.3, 12))} + across * 0.7);
      float inChevron = step(across, ${f(spacing * 0.3)}) * step(abs(fr.y), ${f(stroke.r * 0.9)});`
          : `// Chevrons « > » qui avancent avec le courant.
      float u = fract((fr.x - clock() * unit * 0.8) / ${f(spacing)}) * ${f(spacing)};
      float across = abs(fr.y);
      float c = abs(u - ${f(spacing * 0.5)} + across * 0.7);
      float inChevron = step(across, ${f(stroke.r * 0.55)}) * ${FLUID_SHAPES[fluid.kind] === "area" ? "0.0" : "1.0"};`
      }
      float chevron = (1.0 - smoothstep(line, line * 1.8, c)) * inChevron;
      float shadow = (1.0 - smoothstep(line * 1.8, line * 3.2, c)) * inChevron;
      float edge = (1.0 - smoothstep(line * 0.3, line * 0.9, abs(fr.z - ${f(stroke.r)}))) * 0.45;
      white = max(white, edge);
      lit = max(lit, edge * sel);
      if (fr.z < best) { best = fr.z; arrow = chevron; arrowShadow = shadow; arrowSel = sel; }
    }
  }`;
    })
    .join("\n  ")}
  ${rocks
    .map(
      ({ rock, fluid }) => `{
    float ring = 1.0 - smoothstep(line * 0.5, line * 1.3, abs(length(p - vec2(${f(rock.x)}, ${f(rock.y)})) - ${f(rock.r)}));
    white = max(white, ring);
    lit = max(lit, ring * ${fluid.id === selected ? "1.0" : "0.0"});
  }`,
    )
    .join("\n  ")}
  // Sources : un cercle en pointillés (leur portée) et un point au centre.
  ${fluids
    .flatMap((fluid) => fluid.sources.map((src) => ({ src, fluid })))
    .map(
      ({ src, fluid }) => `{
    vec2 rel = p - vec2(${f(src.x)}, ${f(src.y)});
    float dist = length(rel);
    float dash = step(0.5, fract(atan(rel.y, rel.x) * ${f(Math.max(6, Math.round(src.r / 12)))} / 6.2832));
    float ring = (1.0 - smoothstep(line * 0.4, line * 1.1, abs(dist - ${f(src.r)}))) * dash;
    float dot = 1.0 - smoothstep(line * 1.2, line * 2.0, dist);
    white = max(white, max(ring, dot));
    lit = max(lit, max(ring, dot) * ${fluid.id === selected ? "1.0" : "0.0"});
  }`,
    )
    .join("\n  ")}
  // Pas de chevrons sur les rochers.
  float onRock = 0.0;
  ${rocks.map(({ rock }) => `onRock = max(onRock, step(length(p - vec2(${f(rock.x)}, ${f(rock.y)})), ${f(rock.r)}));`).join("\n  ")}
  arrow *= 1.0 - onRock;
  arrowShadow *= 1.0 - onRock;
  white = max(white, arrow);
  dark = arrowShadow * 0.5;
  lit = max(lit, arrow * arrowSel);
  vec3 color = mix(vec3(1.0), vec3(1.0, 0.82, 0.24), lit);
  float a = max(white, dark);
  return half4(half3(color * white), half(a));
}`;
}

// --- Effets voulus ------------------------------------------------------------------------------

/** Code déjà généré, par géométrie : le régénérer à chaque image d'une transition coûterait cher. */
const cache = new Map<string, string | null>();

/** Rivières et bassins dont le rectangle croise celui de la cascade. */
function watersUnder(fluid: Fluid, all: Fluid[]) {
  if (fluid.kind !== "waterfall") return [];
  const boxOf = (candidate: Fluid) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const stroke of candidate.strokes)
      for (let i = 0; i < stroke.p.length; i += 2) {
        xs.push(stroke.p[i] - stroke.r, stroke.p[i] + stroke.r);
        ys.push(stroke.p[i + 1] - stroke.r, stroke.p[i + 1] + stroke.r);
      }
    return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
  };
  const own = boxOf(fluid);
  if (!own) return [];
  return all.filter((other) => {
    if (other === fluid || !other.enabled || (other.kind !== "water" && other.kind !== "pool")) return false;
    const box = boxOf(other);
    return box && box[0] < own[2] && box[2] > own[0] && box[1] < own[3] && box[3] > own[1];
  });
}

function cachedSksl(fluid: Fluid, unit: number, all: Fluid[]) {
  const under = watersUnder(fluid, all);
  const key = JSON.stringify([fluid.kind, fluid.strokes, fluid.rocks, fluid.sources, Math.round(unit), under.map((water) => water.strokes)]);
  if (!cache.has(key)) {
    if (cache.size > 64) cache.clear();
    cache.set(key, fluidSksl(fluid, unit, under));
  }
  return cache.get(key)!;
}

/** Coulées posées sur le sol de la carte, sous les pions. `fade` : 0 à 1, pour les transitions. */
export function wantedFluids(fluids: Fluid[], quality: Quality, unit: number, fade = 1): WantedEffect[] {
  // Les cascades en dernier : elles se posent sur l'eau qu'elles traversent.
  const ordered = [...fluids.filter((fluid) => fluid.kind !== "waterfall"), ...fluids.filter((fluid) => fluid.kind === "waterfall")];
  return ordered.flatMap((fluid) => {
    if (!fluid.enabled || fluid.opacity <= 0 || fade <= 0) return [];
    const sksl = cachedSksl(fluid, unit, fluids);
    if (!sksl) return [];
    return [
      {
        id: `${PLUGIN_ID}/fluide/${fluid.id}`,
        sksl,
        // La fumée lourde passe sur les pions, comme le brouillard de la météo.
        layer: fluid.kind === "smoke" ? ("RULER" as const) : ("DRAWING" as const),
        zIndex: fluid.kind === "waterfall" ? 1 : 0,
        uniforms: [
          { name: "unit", value: unit },
          { name: "speed", value: fluid.speed },
          { name: "opacity", value: fluid.opacity * fade },
          { name: "layers", value: RAIN_LAYERS[quality] },
          { name: "tint", value: fluid.color ? rgb(fluid.color) : FLUID_TINTS[fluid.kind] },
          { name: "custom", value: fluid.color ? 1 : 0 },
          ...Object.entries(fluid.options).map(([key, value]) => ({ name: `o_${key}`, value })),
        ],
      },
    ];
  });
}

/** Chevrons du sens du courant, pour le MJ pendant qu'il trace. */
export function wantedArrows(fluids: Fluid[], selected: string | null, unit: number): WantedEffect[] {
  const sksl = arrowsSksl(fluids.filter((fluid) => fluid.strokes.length || fluid.sources.length), selected);
  return sksl ? [{ id: `${PLUGIN_ID}/fleches-fluides`, sksl, layer: "CONTROL", uniforms: [{ name: "unit", value: unit }] }] : [];
}
