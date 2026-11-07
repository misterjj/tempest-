// Shaders SkSL de Tempest!. Effets « VIEWPORT » posés en (0, 0) : `coord` est la position sur
// la carte, et `view` la convertit en position à l'écran (doc Owlbear : vec3(coord, 1) * view).
// Les couleurs sont renvoyées prémultipliées par l'opacité, comme l'attend Owlbear.
//
// Owlbear fournit déjà size, position, scale, rotation, model, view, modelView et time :
// ne jamais déclarer un uniform personnel sous l'un de ces noms avec un autre type
// (le shader ne se charge plus, et la carte devient noire).

import { optionsOf, type FilterKind, type WeatherKind } from "../state";
import { MASK_HELPERS } from "./mask";

const HEADER = `
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
    float len = (0.35 + 0.35 * fract(seed * 3.71)) * mix(1.0, 0.6 + 0.8 * fract(seed * 5.1), variety);
    // Bornes dans l'ordre : smoothstep inversé n'est pas garanti partout.
    float streak = (1.0 - smoothstep(0.0, thin, x)) * smoothstep(0.0, 0.15, f.y) * (1.0 - smoothstep(len - 0.15, len, f.y));
    alpha = max(alpha, streak * (0.45 + 0.25 * depth));
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
    float cellSize = size * (0.55 + 0.3 * depth);
    float fall = size * (0.75 + 0.45 * depth) * speed;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(fall)) / cellSize + depth * vec2(5.1, 3.7);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 17.0);
    if (seed > dens) continue;
    vec2 f = g - cell;
    float swing = 0.1 + turbulence * 0.3;
    vec2 center = vec2(0.5 + swing * sin(clock() * (0.8 + seed) + seed * 6.28), 0.5 + 0.3 * (fract(seed * 5.3) - 0.5));
    float r = (0.05 + 0.04 * fract(seed * 7.1)) * (1.0 - 0.2 * depth) * sizeOf(seed);
    float flake = 1.0 - smoothstep(r * 0.4, r, length(f - center));
    alpha = max(alpha, flake * (0.9 - 0.2 * depth));
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
  vec2 q = vec2((along - travel(size * 6.0 * speed)) / (size * 7.0), across / (size * 2.2));
  float haze = smoothstep(0.3, 0.85, fbm(q, layers + 1.0)) * (0.25 + 0.5 * min(dens, 1.0));
  vec2 g = vec2(along - travel(size * 14.0 * speed), across) / (size * 0.18);
  vec2 cell = floor(g);
  float seed = rnd(cell);
  float grain = 0.0;
  if (seed < dens * 0.5) {
    vec2 f = g - cell;
    float s = sizeOf(seed);
    grain = (1.0 - smoothstep(0.0, 0.35 * s, abs(f.y - 0.5))) * (1.0 - smoothstep(0.1, 0.5 * s, abs(f.x - 0.5))) * 0.8;
  }
  alpha = max(haze, grain);
  // Tourbillons : des colonnes de poussière en spirale, qui naissent, errent et s'effacent.
  if (o_whirls > 0.0) {
    vec2 wg = (p - down * travel(size * 2.0 * speed)) / (size * 8.0);
    vec2 wc = floor(wg);
    float ws = rnd(wc + 43.0);
    if (ws < o_whirls * 0.6) {
      float life = fract(clock() * 0.06 * (0.7 + ws) + ws * 5.0);
      vec2 center = vec2(0.5) + 0.22 * vec2(sin(clock() * 0.3 + ws * 9.0), cos(clock() * 0.23 + ws * 4.0));
      vec2 d = (wg - wc - center) * 8.0;
      float r = length(d);
      float spiral = 0.5 + 0.5 * sin(atan(d.y, d.x) * 3.0 - r * 2.5 + clock() * 6.0);
      float column = (1.0 - smoothstep(0.0, 1.6 * sizeOf(ws), r)) * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.75, 1.0, life));
      alpha = max(alpha, column * (0.25 + 0.55 * spiral));
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
    float r = (0.06 + 0.03 * fract(seed * 3.1)) * sizeOf(seed) * (1.0 - 0.15 * depth);
    // Un peu étiré dans le sens de la chute : le grêlon file.
    d.y = max(abs(d.y) - r * 1.2, 0.0);
    float pellet = 1.0 - smoothstep(r * 0.5, r, length(d));
    alpha = max(alpha, pellet * (0.9 - 0.2 * depth));
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
  // Feuilles ou pétales qui tombent en tournoyant et se retournent.
  leaves: `
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellSize = size * (1.3 + 0.4 * depth);
    float fall = size * (1.2 + 0.5 * depth) * speed;
    vec2 g = vec2(dot(p, side), dot(p, down) - travel(fall)) / cellSize + depth * vec2(6.1, 2.9);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 37.0);
    if (seed > dens * 0.7) continue;
    float c = clock() * (0.8 + seed) * (0.6 + turbulence);
    vec2 d = g - cell - vec2(0.5 + (0.1 + turbulence * 0.1) * sin(c + seed * 6.28), 0.5);
    float rot = c * 1.3 + seed * 6.28;
    d = vec2(cos(rot) * d.x - sin(rot) * d.y, sin(rot) * d.x + cos(rot) * d.y);
    // En se retournant, la feuille paraît plus étroite.
    float flip = 0.3 + 0.7 * abs(sin(c * 1.7 + seed * 4.0));
    float len = 0.2 * sizeOf(seed) * (1.0 - 0.15 * depth);
    float wid = len * 0.55 * flip * (1.0 - 0.6 * min(abs(d.x) / len, 1.0)) + 0.0001;
    float leaf = 1.0 - smoothstep(0.8, 1.0, length(vec2(d.x / len, d.y / wid)));
    if (leaf * (0.95 - 0.15 * depth) > alpha) {
      alpha = leaf * (0.95 - 0.15 * depth);
      // D'une feuille à l'autre, la couleur varie un peu ; la nervure est plus sombre.
      vec3 own = mix(tint, tint * vec3(1.2, 0.75, 0.55), fract(seed * 5.3) * variety);
      float vein = (1.0 - smoothstep(0.0, wid * 0.18 + 0.004, abs(d.y))) * step(abs(d.x), len * 0.8);
      color = clamp(own * (0.75 + 0.25 * flip) * (1.0 - 0.3 * vein), 0.0, 1.0);
    }
  }`,
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
  float edge = 0.9 - min(dens, 1.0) * 0.6;
  alpha = smoothstep(edge, edge + 0.22, v) * 0.6;`,
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
  float air = fbm(vec2((along - travel(size * 7.0 * speed)) / (size * 14.0), across / (size * 1.8)), layers);
  alpha = smoothstep(0.45, 0.85, air) * 0.16 * min(dens * 1.5, 1.0);
  for (int i = 0; i < 2; i++) {
    float depth = float(i);
    if (depth >= layers) break;
    float cellLen = size * (14.0 + 4.0 * depth);
    float cellW = size * (1.6 + 0.6 * depth);
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
    float thin = size * 0.05 * sizeOf(seed) * taper + 0.5;
    float line = (1.0 - smoothstep(thin * 0.4, thin, x)) * taper;
    alpha = max(alpha, line * (0.65 - 0.2 * depth));
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
      float r = 0.09 * sizeOf(seed);
      float chip = 1.0 - smoothstep(0.7, 1.0, length(vec2(d.x / r, d.y / (r * 0.45))));
      alpha = max(alpha, chip * 0.85);
    }
  }`,
  // La brume de chaleur déforme l'image : voir heatSksl.
  heat: "",
};

/** Shader d'un effet météo, avec la fonction `mask` de sa zone (voir maskFunction). */
export const weatherSksl = (kind: WeatherKind, mask: string) =>
  kind === "heat"
    ? heatSksl(mask)
    : `${HEADER}${WEATHER_UNIFORMS}${optionUniforms(kind)}${NATURAL}${MASK_HELPERS}
${mask}
half4 main(float2 coord) {
  float m = mask(coord);
  if (m <= 0.001) return half4(0.0);
  vec2 p = coord;
  ${SETUP}
  float alpha = 0.0;
  vec3 color = tint;
  ${BODIES[kind]}
  float value = clamp(alpha, 0.0, 1.0) * opacity * m;
  return half4(half3(color) * value, value);
}`;

/**
 * Brume de chaleur : relit l'image de la scène un peu à côté, avec un décalage qui ondule et
 * monte. Posée en après-rendu (elle a besoin de `scene`). Le décalage est en unités de carte :
 * il garde la même taille quel que soit le zoom.
 */
const heatSksl = (mask: string) => `${HEADER}${WEATHER_UNIFORMS}${NATURAL}${MASK_HELPERS}
uniform shader scene;
uniform mat3 view;
${mask}
half4 main(float2 coord) {
  float m = mask(coord);
  if (m <= 0.001) return scene.eval((vec3(coord, 1.0) * view).xy);
  vec2 p = coord;
  ${SETUP}
  vec2 q = p / (size * 1.5) - down * travel(0.6 * speed);
  vec2 wave = vec2(vnoise(q), vnoise(q + 7.7)) - 0.5;
  wave += 0.5 * (vec2(vnoise(q * 2.7 + 3.0), vnoise(q * 2.7 + 11.0)) - 0.5);
  vec2 offset = wave * size * 0.25 * min(dens, 1.0) * opacity * m;
  return scene.eval((vec3(coord + offset, 1.0) * view).xy);
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

// --- Après-rendu : heure du jour et filtres -------------------------------------------------

/** Flou : rayon maximal à l'écran et nombre de points relus autour de chaque pixel. */
const BLUR_MAX_PX = 16;
const BLUR_TAPS = 16;

/** Code de chaque filtre, appliqué à `rgb` dans l'ordre affiché au MJ. Réglage : f_<filtre>. */
const FILTER_CODE: Record<FilterKind, string> = {
  // Le flou relit la scène autour du point : il est fait à la lecture, voir `gradeSksl`.
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

/**
 * Shader d'étalonnage d'une ambiance (heure du jour et filtres) : relit l'image de la scène et la
 * ré-étalonne là où `mask` vaut 1. Seuls les filtres activés sont écrits dans le code.
 * Réglages de l'heure : tint (teinte), bright (luminosité), sat (saturation), contr (contraste).
 */
export function gradeSksl(mask: string, time: boolean, filters: FilterKind[]) {
  return `${HEADER}
uniform shader scene;
uniform mat3 view;
uniform vec2 size;
uniform vec3 tint;
uniform float bright;
uniform float sat;
uniform float contr;
${filters.map((kind) => `uniform float f_${kind};`).join("\n")}
${MASK_HELPERS}
${mask}
half4 main(float2 coord) {
  vec2 screen = (vec3(coord, 1.0) * view).xy;
  half4 base = scene.eval(screen);
  float m = mask(coord);
  if (m <= 0.001) return base;
  half4 c = base;${
    filters.includes("blur")
      ? `
  // Flou : disque de points en spirale (angle d'or), rayon jusqu'à ${BLUR_MAX_PX} px à l'écran.
  {
    float radius = f_blur * ${BLUR_MAX_PX.toFixed(1)};
    half4 sum = base;
    for (int i = 0; i < ${BLUR_TAPS}; i++) {
      float a = float(i) * 2.39996;
      float d = sqrt((float(i) + 0.5) / ${BLUR_TAPS.toFixed(1)}) * radius;
      sum += scene.eval(screen + vec2(cos(a), sin(a)) * d);
    }
    c = sum / ${(BLUR_TAPS + 1).toFixed(1)};
  }`
      : ""
  }
  if (c.a <= 0.0) return mix(base, c, half(m));
  // Couleurs sans l'opacité, pour l'étalonnage.
  vec3 rgb = vec3(c.rgb) / float(c.a);
  ${
    time
      ? `// Désaturer d'abord, puis teinter : la teinte de la nuit reste visible.
  rgb = mix(vec3(dot(rgb, vec3(0.299, 0.587, 0.114))), rgb, sat);
  rgb = rgb * tint * bright;
  rgb = (rgb - 0.5) * contr + 0.5;`
      : ""
  }
  ${filters.map((kind) => FILTER_CODE[kind]).join("\n  ")}
  rgb = clamp(rgb, 0.0, 1.0);
  return mix(base, half4(half3(rgb) * c.a, c.a), half(m));
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
