// Shaders SkSL de Tempest!. Effets « VIEWPORT » posés en (0, 0) : `coord` est la position sur
// la carte, et `view` la convertit en position à l'écran (doc Owlbear : vec3(coord, 1) * view).
// Les couleurs sont renvoyées prémultipliées par l'opacité, comme l'attend Owlbear.
//
// Owlbear fournit déjà size, position, scale, rotation, model, view, modelView et time :
// ne jamais déclarer un uniform personnel sous l'un de ces noms (le shader ne se charge plus).

const HEADER = `
uniform float time;
uniform float unit;
// time est l'heure Unix en secondes : trop grand pour animer sans perdre en précision.
float clock() {
  return mod(time, 1000.0);
}
`;

/**
 * Pluie : des traits fins sur trois profondeurs. Tout est exprimé en cases (`unit`), pour
 * garder des gouttes de la même taille quelle que soit la carte.
 * `angle` : 180 = vers le bas. `density` : 0 à 1, déjà réduite selon la qualité.
 */
export const rainSksl = (mask: string) => `${HEADER}
uniform float angle;
uniform float wind;
uniform float density;
uniform float drops;
uniform float opacity;
uniform float layers;
uniform vec3 tint;
${mask}
// Hachage sans sinus : moins cher, et stable sur toutes les cartes graphiques.
float rnd(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
half4 main(float2 coord) {
  vec2 p = coord;
  float m = mask(p);
  if (m <= 0.001) return half4(0.0);
  float a = radians(angle + wind * 4.0);
  vec2 down = vec2(sin(a), -cos(a));
  vec2 side = vec2(-down.y, down.x);
  float size = unit * drops;
  float thin = size * 0.022;
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    float depth = float(i);
    // Niveau de qualité : 1 à 3 profondeurs dessinées.
    if (depth >= layers) break;
    float width = size * (0.16 + 0.07 * depth);
    float height = size * (0.9 + 0.5 * depth);
    float speed = size * (9.0 + 4.0 * depth);
    vec2 g = vec2(dot(p, side) / width, (dot(p, down) - clock() * speed) / height) + depth * vec2(13.7, 7.3);
    vec2 cell = floor(g);
    float seed = rnd(cell + depth * 31.0);
    if (seed > density) continue;
    vec2 f = g - cell;
    float x = abs(f.x - 0.2 - 0.6 * fract(seed * 7.13)) * width;
    float len = 0.35 + 0.35 * fract(seed * 3.71);
    // Bornes dans l'ordre : smoothstep inversé n'est pas garanti partout.
    float streak = (1.0 - smoothstep(0.0, thin, x)) * smoothstep(0.0, 0.15, f.y) * (1.0 - smoothstep(len - 0.15, len, f.y));
    alpha = max(alpha, streak * (0.45 + 0.25 * depth));
  }
  float value = alpha * opacity * m;
  return half4(half3(tint) * value, value);
}`;

/**
 * Heure du jour, sur la couche d'après-rendu : relit l'image de la scène et la ré-étalonne.
 * `strength` : 0 = scène intacte, 1 = pleine nuit (ou la teinte choisie).
 */
export const gradeSksl = (mask: string) => `
uniform shader scene;
uniform mat3 view;
uniform vec3 tint;
uniform float strength;
${mask}
half4 main(float2 coord) {
  // L'image de la scène se lit en coordonnées écran ; le masque, en coordonnées de la carte.
  half4 c = scene.eval((vec3(coord, 1.0) * view).xy);
  float m = mask(coord) * strength;
  if (m <= 0.001) return c;
  half l = dot(c.rgb, half3(0.299, 0.587, 0.114));
  half3 graded = mix(half3(l), c.rgb, 0.35) * half3(tint) * 0.6;
  return half4(mix(c.rgb, graded * c.a, m), c.a);
}`;

/**
 * Masque vu par le MJ pendant qu'il peint : la zone teintée, le reste intact.
 * `strength` : plus fort pour la zone en cours d'édition.
 */
export const maskOverlaySksl = (mask: string) => `
uniform vec3 tint;
uniform float strength;
${mask}
half4 main(float2 coord) {
  float m = mask(coord) * strength;
  return half4(half3(tint) * m, m);
}`;
