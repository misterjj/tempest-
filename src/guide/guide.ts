// Page guide de Tempest! : ciel d'orage, pluie, éclairs, comparaisons avant / après, clips et liens.
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";

/** Liens à renseigner. Vide : le bouton reste visible et signale qu'il arrive bientôt. */
const LINKS: Record<string, string> = {
  store: "",
  patreon: "https://www.patreon.com/misterjj_obr",
};

/** La page est en anglais, ou en français sous /fr/. */
const lang = document.documentElement.lang === "fr" ? "fr" : "en";
const TEXT = {
  en: { soon: "Coming soon", copy: "Click to copy", copied: "Copied ✓", missing: "Video to record:", placeholder: "Placeholder: the video is not recorded yet" },
  fr: { soon: "Bientôt disponible", copy: "Cliquer pour copier", copied: "Copié ✓", missing: "Vidéo à tourner :", placeholder: "Provisoire : la vidéo n'est pas encore tournée" },
}[lang];

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- Éclairs : un flash sur la page et dans le ciel de l'ouverture ---------------

const flashEl = document.getElementById("flash")!;
/** Intensité de l'éclair en cours, lue par le ciel (0 à 1). */
let bolt = 0;
let boltX = 0.7;

function lightning(x = 0.3 + Math.random() * 0.6) {
  if (reducedMotion) return;
  boltX = x;
  const start = performance.now();
  // Deux coups rapprochés, comme un vrai éclair, puis il s'éteint.
  const step = (now: number) => {
    const t = (now - start) / 1000;
    const v = Math.max(0, Math.exp(-t * 9) + (t > 0.12 ? 0.7 * Math.exp(-(t - 0.12) * 7) : 0));
    bolt = Math.min(1, v);
    flashEl.style.opacity = String(bolt * 0.35);
    if (t < 1.2) requestAnimationFrame(step);
    else { bolt = 0; flashEl.style.opacity = "0"; }
  };
  requestAnimationFrame(step);
}

// --- Ciel d'orage de l'ouverture (WebGL) -------------------------------------------

const hero = document.querySelector<HTMLElement>(".hero")!;
const sky = document.getElementById("sky") as HTMLCanvasElement;
let heroVisible = true;
new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting)).observe(hero);

const FRAG = `
precision mediump float;
uniform vec2 res; uniform float time; uniform float bolt; uniform float boltX;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.02 + 3.7; a *= 0.5; } return v; }
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float t = time * 0.035;
  // Des nuages lourds qui roulent vers la droite, plus denses en haut.
  vec2 q = vec2(fbm(p * 1.3 + vec2(t, 0.0)), fbm(p * 1.3 + vec2(-t * 0.6, 2.7)));
  float n = fbm(p * 1.8 + q * 2.2 + vec2(t * 1.6, 0.0));
  float top = smoothstep(-0.2, 1.0, uv.y);
  vec3 base = mix(vec3(0.02, 0.035, 0.06), vec3(0.04, 0.07, 0.12), top);
  vec3 cloud = mix(vec3(0.06, 0.1, 0.17), vec3(0.2, 0.28, 0.4), smoothstep(0.45, 0.85, n));
  vec3 col = mix(base, cloud, smoothstep(0.35, 0.8, n) * (0.35 + 0.65 * top));
  // L'éclair éclaire les nuages par-dessous, autour de son point de chute.
  float near = exp(-2.2 * abs(uv.x - boltX)) * (0.4 + 0.6 * top);
  col += vec3(0.55, 0.75, 1.0) * bolt * near * (0.25 + smoothstep(0.4, 0.9, n));
  col *= 1.0 - 0.4 * length(uv - vec2(0.5, 0.6));
  gl_FragColor = vec4(col, 1.0);
}`;

function startSky() {
  const gl = sky.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) return;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }"));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const [uRes, uTime, uBolt, uBoltX] = ["res", "time", "bolt", "boltX"].map((n) => gl.getUniformLocation(prog, n));
  const start = performance.now();

  const frame = () => {
    // Le ciel est calculé à mi-résolution : il est flou par nature.
    const w = Math.round(sky.clientWidth * 0.5), h = Math.round(sky.clientHeight * 0.5);
    if (sky.width !== w || sky.height !== h) { sky.width = w; sky.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uTime, (performance.now() - start) / 1000);
    gl.uniform1f(uBolt, bolt);
    gl.uniform1f(uBoltX, boltX);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = () => {
    if (heroVisible && !document.hidden) frame();
    requestAnimationFrame(loop);
  };
  if (reducedMotion) frame();
  else loop();
}
startSky();

// Un éclair de temps en temps tant que l'ouverture est à l'écran, et un au clic dans le ciel.
if (!reducedMotion) {
  const next = () => setTimeout(() => {
    if (heroVisible && !document.hidden) lightning();
    next();
  }, 7000 + Math.random() * 9000);
  setTimeout(() => { lightning(0.75); next(); }, 1800);
}
hero.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a, button, figure")) return;
  lightning(e.clientX / innerWidth);
});

// --- Pluie fine sur toute la page (canvas 2D) ---------------------------------------

const rain = document.getElementById("rain") as HTMLCanvasElement;
const ctx = rain.getContext("2d")!;
type Drop = { x: number; y: number; len: number; speed: number; alpha: number };
const drops: Drop[] = [];
const DROPS = innerWidth < 760 ? 70 : 160;
/** Pente de la pluie : elle tombe un peu vers la gauche. */
const SLANT = -0.18;
let dpr = 1;

function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  rain.width = innerWidth * dpr;
  rain.height = innerHeight * dpr;
}
addEventListener("resize", resize);
resize();

const drop = (anywhere: boolean): Drop => ({
  x: Math.random() * (innerWidth + 200),
  y: anywhere ? Math.random() * innerHeight : -40 - Math.random() * 200,
  len: 10 + Math.random() * 22,
  speed: 9 + Math.random() * 9,
  alpha: 0.08 + Math.random() * 0.22,
});
for (let i = 0; i < DROPS; i++) drops.push(drop(true));

function tick() {
  requestAnimationFrame(tick);
  if (document.hidden) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.lineCap = "round";
  ctx.lineWidth = 1;
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    d.y += d.speed;
    d.x += d.speed * SLANT;
    if (d.y > innerHeight + 40) drops[i] = drop(false);
    ctx.strokeStyle = `rgb(190 225 255 / ${d.alpha + bolt * 0.4})`;
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x - d.len * SLANT, d.y - d.len);
    ctx.stroke();
  }
}
if (!reducedMotion) tick();

// --- Comparaison avant / après ---------------------------------------------------

const isVideo = (src: string) => /\.(mp4|webm|mov)$/i.test(src);

/**
 * Le fichier existe-t-il ? Un fichier absent ne renvoie pas toujours 404 : le serveur de dev et
 * Cloudflare Pages répondent par la page HTML, que la vidéo mettrait longtemps à refuser.
 */
async function exists(src: string) {
  try {
    const response = await fetch(src, { method: "HEAD" });
    return response.ok && !(response.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/** Charge une image ou une vidéo ; null si le fichier n'existe pas encore. */
async function loadMedia(src: string): Promise<HTMLVideoElement | HTMLImageElement | null> {
  if (!(await exists(src))) return null;
  return new Promise((resolve) => {
    if (isVideo(src)) {
      const video = document.createElement("video");
      Object.assign(video, { muted: true, loop: true, playsInline: true, preload: "auto" });
      video.setAttribute("aria-hidden", "true");
      video.addEventListener("loadeddata", () => resolve(video), { once: true });
      video.addEventListener("error", () => resolve(null), { once: true });
      video.src = src;
    } else {
      const img = new Image();
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("load", () => resolve(img), { once: true });
      img.addEventListener("error", () => resolve(null), { once: true });
      img.src = src;
    }
  });
}

function setupCompare(fig: HTMLElement) {
  const stage = fig.querySelector<HTMLElement>(".compare-stage")!;
  const handle = fig.querySelector<HTMLElement>(".handle")!;
  const onLayer = fig.querySelector<HTMLElement>(".layer.on")!;
  const offLayer = fig.querySelector<HTMLElement>(".layer.off")!;
  let pos = 50;
  let touched = false;

  const set = (value: number) => {
    pos = Math.min(100, Math.max(0, value));
    fig.style.setProperty("--pos", `${pos}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(pos)));
    // OFF à gauche, ON à droite : une étiquette s'efface quand la poignée passe dessus.
    fig.dataset.near = pos < 22 ? "off" : pos > 78 ? "on" : "";
  };
  set(50);

  const fromPointer = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 100);
  };
  stage.addEventListener("pointerdown", (e) => {
    touched = true;
    fig.classList.add("dragging");
    stage.setPointerCapture(e.pointerId);
    fromPointer(e);
    handle.focus({ preventScroll: true });
  });
  stage.addEventListener("pointermove", (e) => { if (stage.hasPointerCapture(e.pointerId)) fromPointer(e); });
  const release = () => fig.classList.remove("dragging");
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  handle.addEventListener("keydown", (e) => {
    const steps: Record<string, number> = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -20, PageUp: 20 };
    if (e.key in steps) set(pos + steps[e.key]);
    else if (e.key === "Home") set(0);
    else if (e.key === "End") set(100);
    else return;
    touched = true;
    e.preventDefault();
  });

  // Une fois à l'écran, la poignée oscille une fois pour montrer qu'elle bouge.
  const nudge = () => {
    if (touched || reducedMotion) return;
    const start = performance.now();
    const step = (now: number) => {
      if (touched) return;
      const t = (now - start) / 1800;
      if (t >= 1) return set(50);
      set(50 + Math.sin(t * Math.PI * 2) * 14 * (1 - t));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  let videos: HTMLVideoElement[] = [];
  let loaded = false;
  let visible = false;
  const play = () => { for (const v of videos) v.play().catch(() => {}); };

  const load = async () => {
    loaded = true;
    let [on, off] = await Promise.all([loadMedia(fig.dataset.on!), loadMedia(fig.dataset.off!)]);
    // Pas encore tourné : la carte provisoire des deux côtés, la météo imitée côté « on ».
    const fallback = fig.dataset.fallback;
    if ((!on || !off) && fallback) {
      const missing = [!on && fig.dataset.on, !off && fig.dataset.off].filter(Boolean).map((s) => (s as string).split("/").pop());
      [on, off] = await Promise.all([loadMedia(fallback), loadMedia(fallback)]);
      onLayer.classList.add("fake");
      if (fig.dataset.fake) onLayer.classList.add(fig.dataset.fake);
      const note = document.createElement("p");
      note.className = "missing";
      note.textContent = `${TEXT.missing} ${missing.join(", ")}`;
      note.title = TEXT.placeholder;
      stage.append(note);
    }
    if (on) onLayer.append(on);
    if (off) offLayer.append(off);
    videos = [on, off].filter((m): m is HTMLVideoElement => m instanceof HTMLVideoElement);
    // Les deux vidéos restent calées sur la première, à quelques images près.
    if (videos.length === 2) {
      const [lead, follow] = videos;
      lead.addEventListener("timeupdate", () => {
        if (Math.abs(follow.currentTime - lead.currentTime) > 0.08) follow.currentTime = lead.currentTime;
      });
      lead.addEventListener("seeked", () => { follow.currentTime = lead.currentTime; });
    }
    if (visible) play();
  };

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !loaded) load();
    if (visible) { play(); if (e.intersectionRatio > 0.5) nudge(); }
    else for (const v of videos) v.pause();
  }, { rootMargin: "300px 0px", threshold: [0, 0.6] }).observe(fig);
}
for (const fig of document.querySelectorAll<HTMLElement>("figure.compare")) setupCompare(fig);

// --- Clips : chargés à l'approche, joués seulement quand ils sont à l'écran ---------

const clips = new Map<HTMLElement, HTMLVideoElement>();
const visibleClips = new Set<HTMLElement>();
const clipObserver = new IntersectionObserver(
  (entries) => {
    for (const { target, isIntersecting } of entries) {
      const fig = target as HTMLElement;
      let video = clips.get(fig);
      if (!isIntersecting) {
        visibleClips.delete(fig);
        video?.pause();
        continue;
      }
      visibleClips.add(fig);
      if (!video) {
        video = document.createElement("video");
        Object.assign(video, { muted: true, loop: true, playsInline: true, preload: "auto" });
        video.setAttribute("aria-hidden", "true");
        // La vidéo charge hors de la page, l'emplacement reste là jusqu'à la première image.
        const slot = fig.querySelector<HTMLElement>(".slot")!;
        const ready = video;
        video.addEventListener("loadeddata", () => {
          slot.replaceWith(ready);
          if (visibleClips.has(fig)) ready.play().catch(() => {});
        }, { once: true });
        // Pas encore tournée : l'emplacement dit quel fichier mettre dans public/guide/media.
        video.addEventListener("error", () => {
          slot.classList.add("missing");
          slot.title = TEXT.placeholder;
          const name = document.createElement("code");
          name.textContent = fig.dataset.src!.split("/").pop()!;
          slot.append(name);
        }, { once: true });
        const src = fig.dataset.src!;
        clips.set(fig, video);
        exists(src).then((ok) => {
          if (ok) ready.src = src;
          else ready.dispatchEvent(new Event("error"));
        });
      }
      video.play().catch(() => {});
    }
  },
  { rootMargin: "300px 0px" },
);

for (const fig of document.querySelectorAll<HTMLElement>("figure.clip[data-src]")) {
  const slot = document.createElement("div");
  slot.className = "slot";
  fig.prepend(slot);
  clipObserver.observe(fig);
}

// --- En-tête, apparition au défilement ----------------------------------------

const top = document.querySelector(".top")!;
const menuButton = top.querySelector<HTMLButtonElement>(".menu-toggle")!;
const setMenu = (open: boolean) => {
  top.classList.toggle("open", open);
  menuButton.setAttribute("aria-expanded", String(open));
};
menuButton.addEventListener("click", () => setMenu(!top.classList.contains("open")));
for (const link of top.querySelectorAll("nav a")) link.addEventListener("click", () => setMenu(false));
const onScroll = () => top.classList.toggle("scrolled", scrollY > 40);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("shown"); reveal.unobserve(e.target); }
  },
  { threshold: 0.12 },
);
for (const el of document.querySelectorAll(".chapter .wrap, .band .wrap, .ritual li, .checklist")) {
  el.classList.add("reveal");
  reveal.observe(el);
}

// --- Liens externes ------------------------------------------------------------

for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-link]")) {
  const url = LINKS[a.dataset.link ?? ""];
  if (url) {
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.classList.add("soon");
    a.title = TEXT.soon;
    a.addEventListener("click", (e) => e.preventDefault());
  }
}

// --- Copie de l'adresse du manifest ----------------------------------------------

for (const button of document.querySelectorAll<HTMLElement>(".copy[data-copy]")) {
  const label = button.querySelector("b");
  const idle = label?.textContent ?? "";
  button.title = TEXT.copy;
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy!);
    button.classList.add("copied");
    if (label) label.textContent = TEXT.copied;
    setTimeout(() => {
      button.classList.remove("copied");
      if (label) label.textContent = idle;
    }, 1600);
  });
}
