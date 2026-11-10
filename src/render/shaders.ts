// Shaders SkSL de Tempest!. Effets « VIEWPORT » posés en (0, 0) : `coord` est la position sur
// la carte, et `view` la convertit en position à l'écran (doc Owlbear : vec3(coord, 1) * view).
// Les couleurs sont renvoyées prémultipliées par l'opacité, comme l'attend Owlbear.
//
// Owlbear fournit déjà size, position, scale, rotation, model, view, modelView et time :
// ne jamais déclarer un uniform personnel sous l'un de ces noms avec un autre type
// (le shader ne se charge plus, et la carte devient noire).

import { optionsOf, type FilterKind, type LeafShape, type WeatherKind } from "../state";
import { MASK_HELPERS } from "./mask";

export const HEADER = `
uniform float time;
uniform float unit;
// time est l'heure Unix en secondes : trop grand pour animer sans perdre en précision.
float clock() {
  return mod(time, 1000.0);
}
// Hachage sans sinus : moins cher, et stable sur toutes les cartes graphiques.
float rnd(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rnd(i), rnd(i + vec2(1.0, 0.0)), f.x), mix(rnd(i + vec2(0.0, 1.0)), rnd(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Bruit fractal ; le niveau de qualité règle le nombre d'octaves (2 à 4).
float fbm(vec2 p, float octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= octaves) break;
    value += amplitude * vnoise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    amplitude *= 0.5;
  }
  return value;
}
`;

/**
 * Réglages communs des effets météo. Tout est exprimé en cases (`unit`) : les gouttes gardent la
 * même taille quelle que soit la carte. `angle` : sens du mouvement, 180 = vers le bas de l'écran.
 * `speed` : multiplicateur de la vitesse naturelle de l'effet (1 = naturelle).
 * `density` : 0 à 1, déjà réduite selon la qualité. `layers` : 1 à 3 selon la qualité.
 */
const WEATHER_UNIFORMS = `
uniform float angle;
uniform float speed;
uniform float density;
uniform float drops;
uniform float opacity;
uniform float layers;
uniform vec3 tint;
uniform float turbulence;
uniform float gusts;
uniform float variety;
uniform float patches;
`;

/** Uniforms des options de la météo (o_<option>) : seules celles de son type sont déclarées. */
const optionUniforms = (kind: WeatherKind) => optionsOf(kind).map((key) => `uniform float o_${key};`).join("\n");

/**
 * Outils des effets naturels. `travel` donne le chemin parcouru : avec des rafales, la vitesse
 * monte et retombe, mais le chemin reste continu (une vitesse variable multipliée par le temps
 * ferait sauter les particules). Sa dérivée ne descend jamais sous 0 : rien ne recule.
 */
const NATURAL = `
float travel(float base) {
  float c = clock();
  return base * (c + gusts * (sin(c * 0.37) + 0.6 * sin(c * 0.83 + 1.3)));
}
// -1 à 1 : la rafale en cours, au même rythme que travel.
float gustWave() {
  float c = clock();
  return (0.37 * cos(c * 0.37) + 0.498 * cos(c * 0.83 + 1.3)) / 0.868;
}
// Taille d'une particule : identique sans variété, de 0,45 à 1,55 fois au maximum.
float sizeOf(float seed) {
  return mix(1.0, 0.45 + 1.1 * fract(seed * 13.7), variety);
}
`;

/** Direction, déformation du champ (turbulence), rafales et nappes : communs à toutes les météos. */
const SETUP = `
  float a = radians(angle);
  vec2 down = vec2(sin(a), -cos(a));
  vec2 side = vec2(-down.y, down.x);
  float size = unit * drops;
  // Turbulence : le champ entier ondule lentement, comme poussé par des remous.
  vec2 warp = vec2(vnoise(p / (size * 3.0) + clock() * 0.15), vnoise(p / (size * 3.0) + 7.3 - clock() * 0.12)) - 0.5;
  p += side * warp.x * turbulence * size * 1.4 + down * warp.y * turbulence * size * 0.6;
  // Rafales : plus dense quand le vent forcit. Nappes : plus dense par endroits, qui avancent.
  float dens = density * (1.0 + gusts * 0.35 * gustWave());
  float clump = smoothstep(0.2, 0.8, vnoise((coord - down * travel(size * 1.5)) / (size * 10.0)));
  dens *= mix(1.0, clump * 1.7, patches);
`;

/** Éclairs, pour la pluie et la grêle. */
const LIGHTNING = `
  // Éclairs : par fenêtres de 2,5 s, une chance de coup de tonnerre, avec un double éclat.
  if (o_lightning > 0.0) {
    float window = clock() * 0.4;
    float bin = floor(window);
    float flash = 0.0;
    if (rnd(vec2(bin, 3.7)) < o_lightning * 0.45) {
      float since = fract(window) * 2.5 - rnd(vec2(bin, 9.1)) * 1.5;
      if (since > 0.0) flash = exp(-since * 9.0) + 0.7 * exp(-max(since - 0.18, 0.0) * 12.0) * step(0.18, since);
    }
    flash = clamp(flash, 0.0, 1.0);
    color = mix(color, vec3(1.0, 1.0, 0.97), flash);
    alpha = max(alpha, flash * 0.45);
  }`;

/** Corps de chaque météo : calcule `alpha` (0 à 1) et `color`. */
/**
 * Mouvement de chaque forme des feuilles : vitesse de chute, tours sur elle-même, balancement,
 * vitesse de retournement et taille (demi-longueur, en fraction de cellule).
 */
const LEAF_MOTION: Record<LeafShape, { fall: number; spin: number; sway: number; flip: number; size: number }> = {
  leaf: { fall: 1, spin: 1.3, sway: 1, flip: 1.7, size: 0.2 },
  maple: { fall: 1, spin: 1, sway: 1, flip: 1.4, size: 0.2 },
  // Le pétale plane : il tombe lentement et dérive beaucoup.
  petal: { fall: 0.6, spin: 0.9, sway: 1.5, flip: 1.2, size: 0.12 },
  // La plume se balance comme un pendule (voir sa rotation), sans tourner sur elle-même.
  feather: { fall: 0.5, spin: 0, sway: 1.5, flip: 0.6, size: 0.24 },
  // Les confettis papillonnent vite ; les pièces tombent droit en se retournant.
  confetti: { fall: 0.9, spin: 2.2, sway: 0.8, flip: 4, size: 0.09 },
  coin: { fall: 1.6, spin: 0.3, sway: 0.4, flip: 3, size: 0.1 },
};

/**
 * Dessin d'une particule, dans son repère tourné `d` (unités de cellule). Disponibles : len (demi-
 * longueur), flip (0,3 à 1 : la forme paraît plus étroite en se retournant), turn (-1 à 1, la face
 * vue), seed. Chaque forme pose `shape` (couverture, 0 à 1) et `own` (sa couleur).
 */
const LEAF_DRAW: Record<LeafShape, string> = {
  // Ovale pointu, nervure plus sombre ; la couleur varie un peu d'une feuille à l'autre.
  leaf: `
    float wid = len * 0.55 * flip * (1.0 - 0.6 * min(abs(d.x) / len, 1.0)) + 0.0001;
    shape = 1.0 - smoothstep(0.8, 1.0, length(vec2(d.x / len, d.y / wid)));
    vec3 hue = mix(tint, tint * vec3(1.2, 0.75, 0.55), fract(seed * 5.3) * variety);
    float vein = (1.0 - smoothstep(0.0, wid * 0.18 + 0.004, abs(d.y))) * step(abs(d.x), len * 0.8);
    own = hue * (0.75 + 0.25 * flip) * (1.0 - 0.3 * vein);`,
  // Feuille d'automne à cinq lobes pointus (érable), nervures vers chaque pointe, et sa queue.
  maple: `
    vec2 q = vec2(d.x, d.y / flip);
    float ang = atan(q.y, q.x);
    float reach = len * (0.45 + 0.55 * pow(abs(cos(ang * 2.5)), 3.0));
    float r = length(q);
    float stem = (1.0 - smoothstep(len * 0.03, len * 0.07, abs(q.y))) * step(-len * 1.25, q.x) * step(q.x, 0.0);
    shape = max(1.0 - smoothstep(reach * 0.88, reach, r), stem);
    vec3 hue = mix(tint, tint * vec3(1.25, 0.6, 0.35), fract(seed * 5.3) * variety);
    hue = mix(hue, vec3(0.95, 0.72, 0.18), fract(seed * 9.1) * variety * 0.45);
    float vein = (1.0 - smoothstep(0.0, 0.12, abs(sin(ang * 2.5)))) * step(r, reach * 0.85);
    own = hue * (0.75 + 0.25 * flip) * (1.0 - 0.28 * vein);`,
  // Pétale de cerisier : ovale encoché au bout, plus clair vers la pointe.
  petal: `
    vec2 q = vec2(d.x / len, d.y / (len * 0.68 * flip));
    float body = 1.0 - smoothstep(0.85, 1.0, length(vec2(q.x, q.y * (1.0 + 0.35 * smoothstep(0.2, -1.0, q.x)))));
    float notch = 1.0 - smoothstep(0.22, 0.32, length(vec2(q.x - 1.02, q.y * 0.8)));
    shape = body * (1.0 - notch);
    vec3 hue = mix(tint, vec3(1.0, 0.96, 0.97), fract(seed * 5.3) * variety * 0.6);
    own = mix(hue * vec3(0.92, 0.72, 0.8), min(hue * 1.08 + 0.05, vec3(1.0)), smoothstep(-0.9, 0.5, q.x)) * (0.82 + 0.18 * flip);`,
  // Plume : tuyau clair qui dépasse en pointe, barbes plus sombres en chevrons, bord effiloché.
  feather: `
    vec2 q = vec2(d.x / len, d.y / (len * 0.42 * (0.5 + 0.5 * flip)));
    float barbs = fract(q.x * 7.0 + abs(q.y) * 2.2 + seed * 3.0);
    float edge = 1.0 - 0.18 * barbs;
    float vane = (1.0 - smoothstep(0.8 * edge, edge, length(vec2(q.x * 1.0, q.y)))) * step(-0.75, q.x);
    float shaft = (1.0 - smoothstep(0.03, 0.07, abs(d.y) / len)) * step(-1.15, q.x) * step(q.x, 0.95);
    shape = max(vane, shaft);
    vec3 hue = tint * mix(1.0, 0.8, fract(seed * 5.3) * variety);
    own = mix(hue * (0.78 + 0.22 * smoothstep(0.0, 0.5, barbs)), min(hue * 1.15 + 0.08, vec3(1.0)), shaft) * (0.8 + 0.2 * flip);`,
  // Confettis : petits rectangles (ou rubans), de toutes les couleurs si aucune n'est choisie.
  confetti: `
    float strip = step(0.72, fract(seed * 3.3));
    vec2 q = vec2(d.x / (len * (1.0 + 1.4 * strip)), d.y / (len * 0.55 * flip));
    shape = (1.0 - smoothstep(0.8, 1.0, abs(q.x))) * (1.0 - smoothstep(0.8, 1.0, abs(q.y)));
    vec3 party = clamp(0.55 + 0.6 * cos(6.2832 * (fract(seed * 7.7) + vec3(0.0, 0.33, 0.67))), 0.0, 1.0);
    vec3 hue = mix(tint * (0.75 + 0.4 * fract(seed * 7.7) * variety), party, multi);
    own = hue * (0.55 + 0.45 * flip);`,
  // Pièce d'or : un disque qui se retourne (il s'amincit de profil) et brille quand il fait face.
  coin: `
    float face = abs(turn);
    float r = length(vec2(d.x / (len * (0.1 + 0.9 * face)), d.y / len));
    shape = 1.0 - smoothstep(0.82, 1.0, r);
    float rim = smoothstep(0.62, 0.72, r);
    vec3 hue = tint * mix(1.0, 0.85, fract(seed * 5.3) * variety);
    own = hue * mix(0.95 + 0.2 * (1.0 - r), 0.62, rim) * (0.55 + 0.45 * face);
    own = mix(own, vec3(1.0, 0.97, 0.85), pow(face, 14.0) * 0.75);`,
};

/** Feuilles, pétales ou objets qui tombent en tournoyant et se retournent. */
function leavesBody(shape: LeafShape) {
  const m = LEAF_MOTION[shape];
  const f = (value: number) => value.toFixed(2);
  // La plume oscille autour de l'horizontale, en phase avec son balancement ; le reste tourne.
  const rot = shape === "feather" ? "(seed - 0.5) * 0.6 + 0.55 * cos(c + seed * 6.28)" : `c * ${f(m.spin)} + seed * 6.28`;
  return `
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (1.3 + 0.4 * depth);
    float fall = size * (1.2 + 0.5 * depth) * speed * ${f(m.fall)};
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(fall)) / cellSize + depth * vec2(6.1, 2.9);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 37.0);
    if (seed > dens * 0.7) continue;
    float c = clock() * (0.8 + seed) * (0.6 + turbulence);
    vec2 d = g - cell - vec2(0.5 + ${f(m.sway)} * (0.1 + turbulence * 0.1) * sin(c + seed * 6.28), 0.5);
    float rot = ${rot};
    d = vec2(cos(rot) * d.x - sin(rot) * d.y, sin(rot) * d.x + cos(rot) * d.y);
    float turn = sin(c * ${f(m.flip)} + seed * 4.0);
    // En se retournant, la particule paraît plus étroite.
    float flip = 0.3 + 0.7 * abs(turn);
    float len = ${f(m.size)} * sizeOf(seed) * (1.0 - 0.15 * depth);
    float shape = 0.0;
    vec3 own = tint;
    ${LEAF_DRAW[shape]}
    if (shape * (0.95 - 0.15 * depth) > alpha) {
      alpha = shape * (0.95 - 0.15 * depth);
      color = clamp(own, 0.0, 1.0);
    }
  }`;
}

const BODIES: Record<WeatherKind, string> = {
  // Traits fins sur trois profondeurs, éclaboussures et éclairs en option.
  rain: `
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float width = size * (0.16 + 0.07 * depth);
    float height = size * (0.9 + 0.5 * depth);
    float fall = size * (10.0 + 4.0 * depth) * speed;
    vec2 g = vec2(dot(p, side) / width, (dot(p, down) - travel(fall)) / height) + depth * vec2(13.7, 7.3);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 31.0);
    if (seed > dens) continue;
    vec2 f = g - cell;
    float sway = turbulence * 0.2 * sin(clock() * (1.5 + seed * 2.0) + seed * 6.28);
    float x = abs(f.x - 0.2 - 0.6 * fract(seed * 7.13) - sway) * width;
    float thin = size * 0.022 * sizeOf(seed);
    float len = min(0.35 + 0.35 * fract(seed * 3.71), 0.7) * mix(1.0, 0.6 + 0.8 * fract(seed * 5.1), variety);
    len = min(len, 0.9);
    // Chaque goutte démarre à sa propre hauteur dans sa case : pas de rangées alignées.
    float fy = f.y - fract(seed * 9.73) * (1.0 - len);
    // Bornes dans l'ordre : smoothstep inversé n'est pas garanti partout.
    float streak = (1.0 - smoothstep(0.0, thin, x)) * smoothstep(0.0, 0.15, fy) * (1.0 - smoothstep(len - 0.15, len, fy));
    // La goutte est en tête : la traînée pâlit derrière elle.
    streak *= 0.45 + 0.55 * smoothstep(0.0, len, fy);
    alpha = max(alpha, streak * (0.4 + 0.3 * depth));
  }
  // Éclaboussures : des ronds d'impact au sol, qui s'élargissent et s'effacent.
  if (o_splashes > 0.0) {
    vec2 sg = coord / (size * 0.9);
    vec2 sc = floor(sg);
    float ss = rnd(sc + 91.0);
    if (ss < dens * o_splashes * 1.2) {
      float life = fract(clock() * (1.2 + ss) + ss * 7.0);
      vec2 sf = sg - sc - (0.25 + 0.5 * vec2(fract(ss * 3.1), fract(ss * 5.7)));
      float r = life * 0.28 * sizeOf(ss);
      float ring = (1.0 - smoothstep(0.0, 0.035, abs(length(sf) - r))) * (1.0 - life);
      alpha = max(alpha, ring * 0.7);
    }
  }
  // Voile de pluie : une brume claire qui passe en rideaux pendant les grosses averses.
  if (o_veil > 0.0) {
    float sheet = fbm(vec2(dot(p, side) / (size * 6.0), (dot(p, down) - travel(size * 6.0 * speed)) / (size * 12.0)), layers);
    float haze = o_veil * min(dens * 1.5, 1.0) * (0.12 + 0.3 * smoothstep(0.35, 0.75, sheet));
    alpha = alpha + haze * (1.0 - alpha);
  }
${LIGHTNING}`,
  // Flocons ronds qui tombent lentement en se balançant.
  snow: `
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (0.5 + 0.3 * depth);
    float fall = size * (0.75 + 0.45 * depth) * speed;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(fall)) / cellSize + depth * vec2(5.1, 3.7);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 17.0);
    if (seed > dens) continue;
    vec2 f = g - cell;
    float swing = 0.1 + turbulence * 0.3;
    vec2 center = vec2(0.5 + swing * sin(clock() * (0.8 + seed) + seed * 6.28), 0.5 + 0.3 * (fract(seed * 5.3) - 0.5));
    // Flocon doux : un cœur clair et un bord flou ; les plus proches sont plus gros.
    float r = (0.07 + 0.06 * fract(seed * 7.1)) * (0.75 + 0.25 * depth) * sizeOf(seed);
    float dd = length(f - center);
    float flake = (1.0 - smoothstep(r * 0.2, r, dd)) * 0.75 + exp(-dd * dd / (r * r * 0.08)) * 0.25;
    alpha = max(alpha, flake * (0.7 + 0.15 * depth));
  }
  // Flocons proches : gros flocons flous qui passent devant, plus vite, pour la profondeur.
  if (o_nearFlakes > 0.0) {
    float cellSize = size * 2.4;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(size * 2.6 * speed)) / cellSize + vec2(2.3, 8.1);
    vec2 cell = floor(g);
    float seed = rnd(cell + 71.0);
    if (seed < dens * o_nearFlakes * 0.6) {
      vec2 center = vec2(0.5 + 0.25 * sin(clock() * (0.5 + seed) + seed * 6.28), 0.5);
      float r = (0.07 + 0.05 * fract(seed * 7.1)) * sizeOf(seed);
      float bokeh = 1.0 - smoothstep(r * 0.1, r, length(g - cell - center));
      alpha = max(alpha, bokeh * 0.5);
    }
  }`,
  // Nappes de brume qui dérivent ; la variété change la taille des nappes.
  fog: `
  vec2 drift = down * travel(size * 0.4 * speed);
  float n = fbm((p - drift) / (size * 4.0), layers + 1.0);
  float n2 = fbm((p + drift * 0.6) / (size * mix(9.0, 15.0, variety)) + 3.7, layers);
  float cover = smoothstep(0.75 - dens * 0.55, 0.95, n * 0.65 + n2 * 0.55);
  alpha = cover * (0.35 + 0.55 * min(dens, 1.0));
  // Du relief : les nappes épaisses sont plus claires, les bords plus gris.
  color = tint * mix(0.86, 1.06, smoothstep(0.2, 0.9, cover));
  // Volutes : de longs filaments étirés dans le sens du vent.
  if (o_wisps > 0.0) {
    vec2 q = vec2(dot(p - drift * 1.6, down) / (size * 9.0), dot(p, side) / (size * 1.1));
    float strand = smoothstep(0.55, 0.8, fbm(q + vec2(0.0, clock() * 0.03), layers + 1.0));
    alpha = max(alpha, strand * o_wisps * (0.3 + 0.4 * min(dens * 1.5, 1.0)));
  }`,
  // Voile étiré dans le sens du vent, et grains rapides.
  sand: `
  float along = dot(p, down);
  float across = dot(p, side);
  float d1 = min(dens, 1.0);
  // Bouffées : grandes nappes étirées dans le vent, déformées entre elles pour moutonner.
  vec2 q = vec2((along - travel(size * 7.0 * speed)) / (size * 14.0), across / (size * 4.0));
  vec2 warp2 = vec2(vnoise(q * 0.5 + vec2(0.0, clock() * 0.04)), vnoise(q * 0.5 + vec2(5.2, 1.3))) - 0.5;
  float sheet = fbm(q + warp2 * vec2(1.2, 0.5), layers + 1.0);
  float thick = smoothstep(0.3, 0.8, sheet);
  // Un voile léger partout, des bouffées plus épaisses par endroits.
  float haze = (0.12 + 0.55 * thick) * (0.3 + 0.7 * d1);
  // Filets de sable rasants : longs, très fins, rapides, groupés en bandes qui vont et viennent.
  vec2 r = vec2((along - travel(size * 18.0 * speed)) / (size * 2.8), across / (size * 0.07));
  float thread = smoothstep(0.62, 0.92, vnoise(r) * 0.7 + vnoise(r * vec2(2.1, 1.0) + 3.1) * 0.3);
  float band = smoothstep(0.35, 0.75, vnoise(vec2((along - travel(size * 9.0 * speed)) / (size * 5.0), across / (size * 1.2))));
  float threads = thread * band * (0.25 + 0.45 * d1) * mix(1.0, 0.6 + 0.8 * fract(sheet * 7.0), variety * 0.5);
  alpha = max(haze, threads);
  // Plus sombre là où c'est épais, plus clair dans les filets.
  color = tint * mix(1.06, 0.82, thick);
  color = mix(color, tint * 1.15, threads);
  // Tourbillons de poussière vus du dessus : un cœur dense qui tourne sur lui-même, des bras de
  // poussière en spirale, une jupe de sable soulevé autour, et son ombre sur le sol. Ils naissent,
  // errent lentement avec le vent et s'effacent.
  if (o_whirls > 0.0) {
    vec2 wg = (p - down * travel(size * 1.5 * speed)) / (size * 10.0);
    // Placés au hasard dans leur case : on regarde les quatre cases les plus proches, pour qu'un
    // tourbillon qui déborde sur la voisine ne soit jamais coupé.
    vec2 base = floor(wg - 0.5);
    for (int k = 0; k < 4; k++) {
      vec2 wc = base + vec2(float(k - (k / 2) * 2), float(k / 2));
      float ws = rnd(wc + 43.0);
      if (ws >= o_whirls * 0.6) continue;
      float life = fract(clock() * 0.05 * (0.7 + ws) + ws * 5.0);
      float grow = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.75, 1.0, life));
      vec2 center = vec2(0.2 + 0.6 * rnd(wc + 7.0), 0.2 + 0.6 * rnd(wc + 19.0))
        + 0.08 * vec2(sin(clock() * 0.21 + ws * 9.0), cos(clock() * 0.17 + ws * 4.0));
      float radius = (0.12 + 0.07 * fract(ws * 7.3)) * (0.75 + 0.25 * grow);
      vec2 d = (wg - wc - center) / radius;
      float rr = length(d);
      if (rr >= 2.6) continue;
      // Tout s'éteint avant la limite du calcul : aucun bord net.
      float reach = 1.0 - smoothstep(1.7, 2.6, rr);
      // Ombre portée, décalée comme par un soleil haut.
      vec2 ds = d - vec2(0.9, 0.7);
      float shadow = exp(-dot(ds, ds) * 0.9) * 0.55 * grow * reach;
      // Bord déchiqueté : le rayon varie avec l'angle, et bouge.
      float spin = clock() * (1.8 + ws);
      vec2 dir = d / max(rr, 0.001);
      float rough = rr * (1.0 + 0.45 * (fbm(dir * 1.7 + vec2(spin * 0.3, ws * 9.0), 2.0) - 0.5));
      // Rotation d'un bloc : bras en spirale, et filaments plus fins enroulés plus serré.
      float turn = atan(d.y, d.x) + rr * 1.6 - spin;
      vec2 sp = vec2(cos(turn), sin(turn)) * rr * 3.4 + vec2(clock() * 0.15, ws * 17.0);
      float turn2 = atan(d.y, d.x) + rr * 5.5 - spin * 1.3;
      vec2 sp2 = vec2(cos(turn2), sin(turn2)) * rr * 6.0 + vec2(ws * 5.0, clock() * 0.1);
      float arms = smoothstep(0.3, 0.75, fbm(sp, 4.0));
      float threadsW = smoothstep(0.6, 0.85, vnoise(sp2)) * (1.0 - smoothstep(0.4, 1.6, rr)) * 0.7;
      float body = exp(-rough * rough * 1.4);
      float skirt = exp(-rough * rough * 0.6) * 0.45;
      float devil = min(1.0, body * (0.7 + 0.3 * arms) + skirt * max(arms, threadsW)) * grow * reach;
      color = mix(color, tint * 0.3, shadow * (1.0 - devil));
      alpha = max(alpha, shadow);
      // Poussière dense plus sombre, bras et filaments éclairés plus clairs.
      float lit = max(arms * (0.3 + 0.7 * body), threadsW);
      color = mix(color, tint * mix(0.74, 1.1, lit), devil);
      alpha = max(alpha, devil * 0.95);
    }
  }`,
  // Points incandescents qui montent en vacillant.
  embers: `
  vec3 hot = vec3(1.0, 0.92, 0.6);
  float glowSum = 0.0;
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (0.9 + 0.4 * depth);
    float rise = size * (0.9 + 0.4 * depth) * speed;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(rise)) / cellSize + depth * vec2(9.3, 2.1);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 23.0);
    if (seed > dens * 0.6) continue;
    vec2 f = g - cell;
    float swing = 0.1 + turbulence * 0.35;
    vec2 center = vec2(0.5 + swing * sin(clock() * (0.7 + seed) + seed * 9.0), 0.5);
    float r = (0.03 + 0.02 * fract(seed * 3.3)) * sizeOf(seed);
    float d = length(f - center);
    // Lueur : un halo chaud plus large autour du point.
    float glow = exp(-d * d / (r * r)) + o_glow * 0.4 * exp(-d * d / (r * r * 12.0));
    float flicker = 0.6 + 0.4 * sin(clock() * (4.0 + seed * 6.0) + seed * 20.0);
    // Crépitement : vacillement plus profond, et de brefs éclats.
    float pop = step(1.0 - o_crackle * 0.3, rnd(vec2(seed * 91.0 + depth, floor(clock() * 10.0 + seed * 7.0))));
    flicker = mix(flicker, flicker * flicker * 0.6 + pop * 1.4, o_crackle);
    float life = smoothstep(0.0, 0.3, f.y) * (1.0 - smoothstep(0.7, 1.0, f.y));
    glowSum = max(glowSum, glow * flicker * life);
  }
  alpha = glowSum;
  color = mix(color, hot, smoothstep(0.5, 1.0, glowSum) * 0.6);`,
  // Grêlons rapides, et des rebonds au sol avec un petit choc.
  hail: `
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (0.55 + 0.2 * depth);
    float fall = size * (7.0 + 3.0 * depth) * speed;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(fall)) / cellSize + depth * vec2(3.3, 9.1);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 41.0);
    if (seed > dens) continue;
    vec2 d = g - cell - vec2(0.25 + 0.5 * fract(seed * 7.3), 0.5);
    float r = (0.07 + 0.04 * fract(seed * 3.1)) * sizeOf(seed) * (1.0 - 0.15 * depth);
    // Grêlon rond et glacé, avec un reflet, et une courte traînée derrière lui.
    float pellet = 1.0 - smoothstep(r * 0.7, r, length(d));
    float shine = 1.0 - smoothstep(0.0, r * 0.55, length(d + vec2(r * 0.3, r * 0.3)));
    float trail = (1.0 - smoothstep(r * 0.15, r * 0.6, abs(d.x))) * step(d.y, 0.0) * (1.0 - smoothstep(0.0, r * 6.0, -d.y)) * 0.35;
    float a = max(pellet, trail) * (0.95 - 0.2 * depth);
    if (a > alpha) {
      alpha = a;
      color = mix(tint * vec3(0.82, 0.9, 1.0), vec3(1.0), shine * pellet);
    }
  }
  {
    vec2 bg = coord / (size * 1.1);
    vec2 bc = floor(bg);
    float bs = rnd(bc + 57.0);
    if (bs < dens * 0.8) {
      float life = fract(clock() * (1.5 + bs) + bs * 7.0);
      vec2 start = 0.3 + 0.4 * vec2(fract(bs * 3.1), fract(bs * 5.7));
      vec2 hop = normalize(vec2(fract(bs * 11.3) - 0.5, fract(bs * 17.9) - 0.5) + 0.001);
      vec2 at = bg - bc;
      float height = 4.0 * life * (1.0 - life);
      float r = 0.05 * (1.0 + height * 0.6) * sizeOf(bs);
      float bounce = (1.0 - smoothstep(r * 0.5, r, length(at - start - hop * life * 0.22))) * (1.0 - life * 0.7);
      float ring = (1.0 - smoothstep(0.0, 0.03, abs(length(at - start) - life * 0.5))) * (1.0 - smoothstep(0.0, 0.35, life));
      alpha = max(alpha, max(bounce * 0.85, ring * 0.5));
    }
  }
${LIGHTNING}`,
  // Feuilles, pétales ou objets qui tombent en tournoyant et se retournent (voir leavesBody).
  leaves: leavesBody("leaf"),
  // Lucioles : des points qui errent et s'allument doucement.
  fireflies: `
  vec3 hot = vec3(1.0, 1.0, 0.8);
  float glowSum = 0.0;
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (1.6 + 0.6 * depth);
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(size * 0.25 * speed)) / cellSize + depth * vec2(4.1, 7.7);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 29.0);
    if (seed > dens * 0.7) continue;
    float c = clock() * (0.25 + 0.2 * seed) * (0.5 + turbulence);
    vec2 wander = vec2(sin(c + seed * 6.28) + 0.3 * sin(c * 2.3 + seed * 3.0), cos(c * 0.8 + seed * 9.0) + 0.3 * sin(c * 1.7)) / 1.3;
    float d = length(g - cell - 0.5 - 0.3 * wander);
    float r = 0.035 * sizeOf(seed);
    float light = exp(-d * d / (r * r)) + o_glow * 0.45 * exp(-d * d / (r * r * 16.0));
    float pulse = smoothstep(0.3, 1.0, 0.5 + 0.5 * sin(clock() * (0.6 + seed * 0.8) + seed * 30.0));
    glowSum = max(glowSum, light * pulse);
  }
  alpha = glowSum;
  color = mix(color, hot, smoothstep(0.6, 1.0, glowSum) * 0.5);`,
  // Ombres de grands nuages qui glissent sur la carte, et se déforment lentement.
  clouds: `
  vec2 q = (p - down * travel(size * 0.8 * speed)) / (size * mix(14.0, 22.0, variety));
  float morph = clock() * 0.02 * (0.5 + turbulence * 2.0);
  float v = fbm(q + vec2(morph, -morph * 0.7), layers + 1.0) * 0.75 + vnoise(q * 0.35 + 5.1 - morph * 0.5) * 0.4;
  // Plus d'intensité : plus de ciel couvert. Bords doux, cœurs plus sombres.
  float edge = 0.78 - min(dens, 1.0) * 0.45;
  float cover = smoothstep(edge - 0.04, edge + 0.08, v);
  float core = smoothstep(edge + 0.08, edge + 0.3, v);
  alpha = cover * (0.4 + 0.15 * core);`,
  // Rayons de soleil qui traversent un feuillage : des bandes de lumière parallèles qui
  // frémissent avec les feuilles, et de la poussière qui y danse.
  sunrays: `
  float across = dot(p, side) / (size * 0.8);
  float along = dot(p, down) / (size * 30.0);
  float c = clock() * 0.05 * speed;
  float bands = vnoise(vec2(across + c, along * 0.3 + c * 0.2)) * 0.7 + vnoise(vec2(across * 2.3 - c * 1.3, along * 0.5 + 4.0)) * 0.45;
  float edge = 0.9 - min(dens, 1.0) * 0.4;
  float beam = smoothstep(edge, edge + 0.16, bands);
  float fade = 0.4 + 0.6 * vnoise(vec2(across * 0.3, along * 2.0 + c));
  float shimmer = 0.85 + 0.15 * sin(clock() * (1.5 + gusts * 3.0) + across * 3.0);
  alpha = beam * fade * shimmer * 0.7;
  if (o_motes > 0.0) {
    vec2 g = (p - down * travel(size * 0.08 * speed)) / (size * 0.6);
    vec2 cell = floor(g);
    float seed = rnd(cell + 61.0);
    if (seed < o_motes * 0.35) {
      float t2 = clock() * (0.2 + seed * 0.3);
      vec2 d = g - cell - 0.5 - 0.3 * vec2(sin(t2 + seed * 6.28), cos(t2 * 0.8 + seed * 3.0));
      float r = 0.06 * sizeOf(seed);
      float twinkle = 0.5 + 0.5 * sin(clock() * (2.0 + seed * 3.0) + seed * 17.0);
      alpha = max(alpha, exp(-dot(d, d) / (r * r)) * twinkle * (0.2 + 1.2 * beam));
    }
  }`,
  // Vent : un souffle d'air à peine visible, et de longs filets très fins, effilés aux deux
  // bouts, qui glissent en se courbant doucement. Pas de tête marquée : ils doivent rester légers.
  wind: `
  float along = dot(p, down);
  float across = dot(p, side);
  // Souffle : un voile très léger, strié dans le sens du vent, qui passe par vagues.
  float run = along - travel(size * 7.0 * speed);
  float air = fbm(vec2(run / (size * 14.0), across / (size * 1.8)), layers);
  float grain = vnoise(vec2(run / (size * 6.0), across / (size * 0.12)));
  alpha = smoothstep(0.45, 0.85, air) * (0.08 + 0.14 * grain) * min(dens * 1.5, 1.0);
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellLen = size * (10.0 + 4.0 * depth);
    float cellW = size * (0.9 + 0.5 * depth);
    float moved = along - travel(size * (6.0 + 2.0 * depth) * speed);
    vec2 g = vec2(across / cellW, moved / cellLen) + depth * vec2(3.1, 5.3);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 13.0);
    if (seed > dens * 0.7) continue;
    vec2 f = g - cell;
    // Le filet s'allonge, puis sa fin le rattrape.
    float life = fract(clock() * (0.18 + 0.15 * seed) * speed + seed * 7.0);
    float head = 0.1 + 0.8 * smoothstep(0.0, 0.65, life);
    float tail = 0.1 + 0.8 * smoothstep(0.35, 1.0, life);
    float span = head - tail;
    if (span < 0.01) continue;
    float t = (f.y - tail) / span;
    if (t <= 0.0 || t >= 1.0) continue;
    // Courbe lente, la même pour tout le filet.
    float bend = 0.18 * sin(f.y * 3.5 + seed * 6.28) * (0.3 + turbulence);
    float x = abs(f.x - 0.5 - bend) * cellW;
    // Effilé aux deux bouts : plus fin et plus pâle aux extrémités.
    float taper = sin(t * 3.1416);
    float thin = size * 0.04 * sizeOf(seed) * taper + 0.5;
    float line = (1.0 - smoothstep(thin * 0.4, thin, x)) * taper;
    alpha = max(alpha, line * (0.6 - 0.15 * depth));
  }
  // Débris emportés : petits éclats qui filent vite en tournant.
  if (o_debris > 0.0) {
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(size * 10.0 * speed)) / (size * 1.1);
    vec2 cell = floor(g);
    float seed = rnd(cell + 83.0);
    if (seed < o_debris * dens * 0.6) {
      vec2 d = g - cell - vec2(0.5 + 0.25 * sin(clock() * 2.0 + seed * 9.0), 0.5);
      float rot = clock() * (3.0 + seed * 4.0) + seed * 6.28;
      d = vec2(cos(rot) * d.x - sin(rot) * d.y, sin(rot) * d.x + cos(rot) * d.y);
      // Brins d'herbe, bouts de feuilles et brindilles : formes et couleurs variées, qui se
      // retournent en tournant.
      float kind = fract(seed * 13.7);
      float flip = 0.25 + 0.75 * abs(sin(clock() * (2.5 + seed * 3.0) + seed * 5.0));
      float r = (0.11 + 0.08 * fract(seed * 5.9)) * sizeOf(seed);
      float stretch = kind < 0.4 ? 0.18 : 0.5;
      float chip = 1.0 - smoothstep(0.7, 1.0, length(vec2(d.x / r, d.y / (r * stretch * flip))));
      if (chip * 0.9 > alpha) {
        alpha = chip * 0.9;
        // Feuilles sèches, paille et brins clairs : ils se détachent sur l'herbe comme sur la pierre.
        vec3 dry = mix(vec3(0.78, 0.6, 0.32), vec3(0.85, 0.78, 0.5), fract(seed * 3.3));
        color = mix(dry, vec3(0.62, 0.42, 0.22), step(0.75, kind)) * (0.75 + 0.25 * flip);
      }
    }
  }`,
  // La brume de chaleur déforme l'image : elle est faite dans l'après-rendu, voir postSksl.
  heat: "",
};

/** Shader d'un effet météo, avec la fonction `mask` de sa zone (voir maskFunction). */
/**
 * Style cartoon (essai) : les formes deviennent des aplats aux bords nets, cernés d'un trait
 * d'encre. Le contour est la bande de faible opacité au bord de chaque forme : pas besoin de lire
 * les pixels voisins. `inner` règle où commence l'aplat, `rim` l'épaisseur du trait.
 */
export const TOON = `
vec4 toon(vec3 color, float alpha, vec3 base, float inner, float rim, float fill, float ownColor) {
  float body = smoothstep(inner - 0.02, inner + 0.02, alpha);
  float line = rim > 0.0 ? smoothstep(inner - rim - 0.02, inner - rim + 0.02, alpha) * (1.0 - body) : 0.0;
  // Deux teintes : ombre et lumière, selon la clarté d'origine. Feuilles et débris gardent leur
  // propre couleur.
  vec3 ref = mix(base, color, ownColor);
  float lum = dot(color, vec3(0.3, 0.55, 0.15)) / max(dot(base, vec3(0.3, 0.55, 0.15)), 0.05);
  vec3 toned = ref * mix(0.82, 1.12, step(0.95, lum) * (1.0 - ownColor) + ownColor * 0.6);
  vec3 ink = ref * 0.22;
  return vec4(mix(ink, toned, body), max(body * fill, line * 0.9));
}
`;

/**
 * Style cartoon de chaque météo : début de l'aplat, épaisseur du trait d'encre (0 : aucun),
 * opacité de l'aplat, et couleur propre de chaque particule gardée (1) ou non (0).
 * Formes pleines : un trait d'encre ; effets vaporeux : des aplats translucides, sans trait.
 */
const TOON_LEVELS: Record<WeatherKind, [number, number, number, number]> = {
  rain: [0.55, 0.14, 0.95, 0],
  snow: [0.42, 0.22, 0.95, 0],
  hail: [0.4, 0.2, 0.95, 0],
  fog: [0.14, 0, 0.5, 0],
  sand: [0.2, 0, 0.6, 1],
  wind: [0.3, 0.12, 0.85, 1],
  embers: [0.4, 0.14, 0.95, 1],
  leaves: [0.45, 0.22, 0.95, 1],
  fireflies: [0.35, 0.12, 0.95, 1],
  clouds: [0.22, 0, 0.45, 0],
  sunrays: [0.25, 0, 0.5, 0],
  heat: [0.35, 0, 1, 0],
};

export const weatherSksl = (kind: WeatherKind, mask: string, cartoon = false, shape: LeafShape = "leaf") =>
  `${HEADER}${WEATHER_UNIFORMS}${optionUniforms(kind)}${kind === "leaves" && shape === "confetti" ? "uniform float multi;\n" : ""}${NATURAL}${MASK_HELPERS}${cartoon ? TOON : ""}
${mask}
half4 main(float2 coord) {
  float m = mask(coord);
  if (m <= 0.001) return half4(0.0);
  vec2 p = coord;
  ${SETUP}
  float alpha = 0.0;
  vec3 color = tint;
  ${kind === "leaves" ? leavesBody(shape) : cartoon && kind === "rain" ? BODIES.rain.replace("float thin = size * 0.022 * sizeOf(seed);", "float thin = size * 0.06 * sizeOf(seed);").replace("float len = min(", "float len = 0.55 * min(") : BODIES[kind]}${
    cartoon
      ? `
  vec4 styled = toon(color, clamp(alpha, 0.0, 1.0), tint, ${TOON_LEVELS[kind].map((v) => v.toFixed(2)).join(", ")});
  color = styled.rgb;
  alpha = styled.a;`
      : ""
  }
  float value = clamp(alpha, 0.0, 1.0) * opacity * m;
  return half4(half3(color) * value, value);
}`;

/** Couleur naturelle de chaque météo, quand le MJ n'en choisit pas. */
export const NATURAL_TINTS: Record<WeatherKind, { x: number; y: number; z: number }> = {
  rain: { x: 0.78, y: 0.85, z: 0.98 },
  snow: { x: 1, y: 1, z: 1 },
  fog: { x: 0.86, y: 0.88, z: 0.92 },
  sand: { x: 0.85, y: 0.7, z: 0.45 },
  embers: { x: 1, y: 0.45, z: 0.12 },
  hail: { x: 0.92, y: 0.96, z: 1 },
  leaves: { x: 0.85, y: 0.42, z: 0.12 },
  fireflies: { x: 0.8, y: 1, z: 0.35 },
  clouds: { x: 0.04, y: 0.06, z: 0.1 },
  sunrays: { x: 1, y: 0.9, z: 0.65 },
  wind: { x: 0.95, y: 0.97, z: 1 },
  heat: { x: 1, y: 1, z: 1 },
};

/** Couleur naturelle de chaque forme des feuilles. */
export const SHAPE_TINTS: Record<LeafShape, { x: number; y: number; z: number }> = {
  leaf: NATURAL_TINTS.leaves,
  maple: { x: 0.88, y: 0.36, z: 0.1 },
  petal: { x: 1, y: 0.78, z: 0.86 },
  feather: { x: 0.92, y: 0.9, z: 0.86 },
  // Teinte des confettis quand une couleur est choisie ; sans elle, ils sont multicolores.
  confetti: { x: 1, y: 0.4, z: 0.6 },
  coin: { x: 1, y: 0.78, z: 0.25 },
};

// --- Après-rendu : heure du jour et filtres -------------------------------------------------

/** Flou : rayon maximal à l'écran et nombre de points relus autour de chaque pixel. */
const BLUR_MAX_PX = 16;
const BLUR_TAPS = 16;

/** Code de chaque filtre, appliqué à `rgb` dans l'ordre affiché au MJ. Réglage : f_<filtre>. */
const FILTER_CODE: Record<FilterKind, string> = {
  // Le flou relit la scène autour du point : il est fait à la lecture, voir `postSksl`.
  blur: "",
  // 0 à 1 : intensité.
  grayscale: "rgb = mix(rgb, vec3(dot(rgb, vec3(0.299, 0.587, 0.114))), f_grayscale);",
  sepia: `rgb = mix(rgb, clamp(vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131))), 0.0, 1.0), f_sepia);`,
  // 0,5 = neutre ; 0 à 1 donne × 0 à × 2.
  brightness: "rgb = rgb * (f_brightness * 2.0);",
  contrast: "rgb = (rgb - 0.5) * (f_contrast * 2.0) + 0.5;",
  saturation: "rgb = mix(vec3(dot(rgb, vec3(0.299, 0.587, 0.114))), rgb, f_saturation * 2.0);",
  // 0,5 = neutre ; tourne la teinte de -180° à +180°.
  hue: `{
    float turn = (f_hue - 0.5) * 6.2832;
    vec3 k = vec3(0.57735);
    rgb = rgb * cos(turn) + cross(k, rgb) * sin(turn) + k * dot(k, rgb) * (1.0 - cos(turn));
  }`,
  vignette: `{
    vec2 uv = screen / size - 0.5;
    rgb *= 1.0 - smoothstep(0.3, 0.85, length(uv) * 1.4) * f_vignette;
  }`,
  grain: `{
    rgb += (rnd(floor(screen) + floor(clock() * 24.0)) - 0.5) * 0.25 * f_grain;
  }`,
};

/** Brume de chaleur dans l'après-rendu : ses réglages, sous le préfixe `h<n>_`. */
export interface PostHeat {
  prefix: string;
  /** Expression SkSL de son masque en `coord`, 0 à 1 */
  mask: string;
}

/** Ambiance dans l'après-rendu : ses réglages, sous le préfixe `l<n>_`. */
export interface PostLook {
  prefix: string;
  /** Fonction SkSL `float <prefix>mask(vec2 p)`, qui tient compte du poids de l'ambiance */
  mask: string;
  time: boolean;
  filters: FilterKind[];
}

export const HEAT_UNIFORMS = ["angle", "speed", "density", "drops", "opacity", "turbulence", "gusts", "patches"] as const;

/**
 * Décalage de la brume de chaleur : l'image est relue un peu à côté, avec une ondulation qui
 * monte. En unités de carte : il garde la même taille quel que soit le zoom.
 */
const HEAT_OFFSET = `
float gustWave() {
  float c = clock();
  return (0.37 * cos(c * 0.37) + 0.498 * cos(c * 0.83 + 1.3)) / 0.868;
}
vec2 heatOffset(vec2 coord, float angle, float speed, float density, float drops, float opacity, float turbulence, float gusts, float patches) {
  float a = radians(angle);
  vec2 down = vec2(sin(a), -cos(a));
  vec2 side = vec2(-down.y, down.x);
  float size = unit * drops;
  float c = clock();
  // Chemin parcouru, rafales comprises (voir travel).
  float road = c + gusts * (sin(c * 0.37) + 0.6 * sin(c * 0.83 + 1.3));
  vec2 p = coord;
  vec2 warp = vec2(vnoise(p / (size * 3.0) + c * 0.15), vnoise(p / (size * 3.0) + 7.3 - c * 0.12)) - 0.5;
  p += side * warp.x * turbulence * size * 1.4 + down * warp.y * turbulence * size * 0.6;
  float dens = density * (1.0 + gusts * 0.35 * gustWave());
  float clump = smoothstep(0.2, 0.8, vnoise((coord - down * size * 1.5 * road) / (size * 10.0)));
  dens *= mix(1.0, clump * 1.7, patches);
  vec2 q = p / (size * 1.5) - down * 0.6 * speed * road;
  vec2 wave = vec2(vnoise(q), vnoise(q + 7.7)) - 0.5;
  wave += 0.5 * (vec2(vnoise(q * 2.7 + 3.0), vnoise(q * 2.7 + 11.0)) - 0.5);
  return wave * size * 0.25 * min(dens, 1.0) * opacity;
}
`;

/**
 * Tout l'après-rendu de la scène en un seul effet : brumes de chaleur, puis heure du jour et
 * filtres de chaque ambiance (la scène d'abord, puis les zones). Owlbear n'enchaîne pas bien
 * plusieurs effets d'après-rendu : quand l'un est recréé, les autres peuvent disparaître.
 * `zoneMasks` : fonctions de masque des zones, partagées par les brumes et les ambiances.
 * Réglages d'une ambiance : tint (teinte), bright, sat, contr (heure) et f_<filtre>.
 */
/**
 * Lumières : `lamps` lumières accrochées aux objets (réglages lamp<i> = (x, y, rayon),
 * lampPower<i>, lampColor<i>, lampFlicker<i> ; Owlbear n'accepte pas de vec4), plus la lueur des
 * coulées de lave : `glowUniforms` (déclarations) et `glow` (code qui ajoute à col et amount).
 * Elles ne retirent que la nuit (l'heure du jour) : les filtres restent.
 */
function lightCode(lamps: number, glowUniforms: string, glow: string) {
  if (!lamps && !glow) return "";
  return `
${Array.from({ length: lamps }, (_, i) => `uniform vec3 lamp${i};\nuniform float lampPower${i};\nuniform vec3 lampColor${i};\nuniform float lampFlicker${i};`).join("\n")}
${glowUniforms}
// Lumière en p : couleur dominante (rgb) et force (a), de 0 à 1.
vec4 lightAt(vec2 p) {
  vec3 col = vec3(0.0);
  float amount = 0.0;
${Array.from(
  { length: lamps },
  (_, i) => `  {
    vec2 d = p - lamp${i}.xy;
    float dist = length(d);
    if (dist < lamp${i}.z) {
      // Comme aux règles : lumière vive jusqu'à mi-rayon, puis pénombre jusqu'au bord.
      float bright = 1.0 - smoothstep(lamp${i}.z * 0.42, lamp${i}.z * 0.56, dist);
      float dim = 0.5 * (1.0 - smoothstep(lamp${i}.z * 0.5, lamp${i}.z, dist));
      float k = max(bright, dim);
      // Flamme : vacille, et la lumière tremble un peu plus au bord.
      float c = clock();
      float flick = 1.0 - lampFlicker${i} * (0.18 + 0.12 * sin(c * 11.0 + ${f(i * 2.3)})) * (0.6 + 0.4 * vnoise(vec2(c * 7.0, ${f(i * 5.1)})));
      float a = clamp(k * lampPower${i} * flick, 0.0, 1.0);
      col += lampColor${i} * a;
      amount = 1.0 - (1.0 - amount) * (1.0 - a);
    }
  }`,
).join("\n")}
${glow}
  return vec4(col / max(amount, 0.0001) * min(amount * 3.0, 1.0), amount);
}
`;
}

const f = (value: number) => {
  const text = (Math.round(value * 100) / 100).toString();
  return text.includes(".") ? text : `${text}.0`;
};

/**
 * `bursts` : effets ponctuels envoyés par le MJ. Réglages flash (0 à 1, éclat blanc d'un éclair)
 * et shakeX, shakeY (décalage de la carte, en unités de carte, pour une secousse). Deux nombres
 * plutôt qu'un vec2 : tous nos réglages sont des nombres ou des vec3, les seuls types sûrs.
 */
export function postSksl(zoneMasks: string, heats: PostHeat[], looks: PostLook[], lamps = 0, glowUniforms = "", glow = "", bursts = false) {
  const lit = lamps > 0 || glow !== "";
  const heatUniforms = heats.flatMap((heat) => HEAT_UNIFORMS.map((name) => `uniform float ${heat.prefix}${name};`));
  const lookUniforms = looks.flatMap((look) => [
    `uniform float ${look.prefix}weight;`,
    `uniform vec3 ${look.prefix}tint;`,
    `uniform float ${look.prefix}bright;`,
    `uniform float ${look.prefix}sat;`,
    `uniform float ${look.prefix}contr;`,
    ...look.filters.map((kind) => `uniform float ${look.prefix}f_${kind};`),
  ]);
  const heatCode = heats.map(
    (heat, index) => `
  {
    float hm${index} = ${heat.mask};
    if (hm${index} > 0.001) at += heatOffset(coord, ${HEAT_UNIFORMS.map((name) => heat.prefix + name).join(", ")}) * hm${index};
  }`,
  );
  const lookCode = looks.map((look, index) => {
    const u = (name: string) => look.prefix + name;
    const filterCode = look.filters.map((kind) => FILTER_CODE[kind].replace(new RegExp(`\\bf_${kind}\\b`, "g"), u(`f_${kind}`))).join("\n    ");
    return `
  {
    float m${index} = ${u("mask")}(coord);
    if (m${index} > 0.001) {
      half4 src = c;${
        look.filters.includes("blur")
          ? `
      // Flou : disque de points en spirale (angle d'or), rayon jusqu'à ${BLUR_MAX_PX} px à l'écran.
      float radius = ${u("f_blur")} * ${BLUR_MAX_PX.toFixed(1)};
      half4 sum = base;
      for (int i = 0; i < ${BLUR_TAPS}; i++) {
        float a = float(i) * 2.39996;
        float d = sqrt((float(i) + 0.5) / ${BLUR_TAPS.toFixed(1)}) * radius;
        sum += scene.eval(screen + vec2(cos(a), sin(a)) * d);
      }
      src = sum / ${(BLUR_TAPS + 1).toFixed(1)};`
          : ""
      }
      if (src.a > 0.0) {
        // Couleurs sans l'opacité, pour l'étalonnage.
        vec3 rgb = vec3(src.rgb) / float(src.a);${
          look.time
            ? `
        // Désaturer d'abord, puis teinter : la teinte de la nuit reste visible.${lit ? "\n        vec3 unlit = rgb;" : ""}
        rgb = mix(vec3(dot(rgb, vec3(0.299, 0.587, 0.114))), rgb, ${u("sat")});
        rgb = rgb * ${u("tint")} * ${u("bright")};
        rgb = (rgb - 0.5) * ${u("contr")} + 0.5;${
          lit
            ? `
        // Lumières : la nuit recule autour d'elles, et leur couleur réchauffe ce qu'elles éclairent.
        if (light.a > 0.001) {
          vec3 warm = unlit * mix(vec3(1.0), light.rgb * 1.25, 0.45);
          rgb = mix(rgb, warm, light.a);
        }`
            : ""
        }`
            : ""
        }
        ${filterCode}
        rgb = clamp(rgb, 0.0, 1.0);
        src = half4(half3(rgb) * src.a, src.a);
      }
      c = mix(c, src, half(m${index}));
    }
  }`;
  });
  return `${HEADER}
uniform shader scene;
uniform mat3 view;
uniform vec2 size;
${heatUniforms.join("\n")}
${lookUniforms.join("\n")}
${MASK_HELPERS}
${zoneMasks}
${looks.map((look) => look.mask).join("\n")}
${heats.length ? HEAT_OFFSET : ""}
${lightCode(lamps, glowUniforms, glow)}
${bursts ? "uniform float flash;\nuniform float shakeX;\nuniform float shakeY;" : ""}
half4 main(float2 coord) {
  vec2 at = coord${bursts ? " + vec2(shakeX, shakeY)" : ""};${heatCode.join("")}
  vec2 screen = (vec3(at, 1.0) * view).xy;${lit ? "\n  vec4 light = lightAt(coord);" : ""}
  half4 base = scene.eval(screen);
  half4 c = base;${lookCode.join("")}${
    bursts
      ? `
  // Éclair : la scène blanchit d'un coup, la nuit comprise.
  if (flash > 0.0) c = half4(mix(c.rgb, half3(0.93, 0.96, 1.0) * c.a, half(flash)), c.a);`
      : ""
  }
  return c;
}`;
}

/**
 * Masque vu par le MJ pendant qu'il peint : la zone teintée, le reste intact.
 * `strength` : plus fort pour la zone en cours d'édition.
 */
export const maskOverlaySksl = (mask: string) => `
uniform vec3 tint;
uniform float strength;
${MASK_HELPERS}
${mask}
half4 main(float2 coord) {
  float m = mask(coord) * strength;
  return half4(half3(tint) * m, m);
}`;
