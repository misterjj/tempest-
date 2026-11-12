import { t } from "../i18n";

const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 90;

interface StepLimits {
  min?: number;
  max?: number;
  /** Un pas fixe, ou « any » : le pas suit alors la grandeur de la valeur. */
  step: number | "any";
  /** Vide a un sens pour ce champ : sans zone exacte, sans fin. On y revient en passant sous le minimum. */
  clearable?: boolean;
}

const adaptiveStep = (value: number, direction: 1 | -1) => {
  // En descendant, 1 et 10 passent déjà au pas plus fin : on repasse par les mêmes valeurs qu'en montant.
  if (direction > 0 ? value < 1 : value <= 1) return 0.1;
  return (direction > 0 ? value < 10 : value <= 10) ? 0.5 : 1;
};

/** Nouvelle valeur du champ après un appui sur − ou +. */
export function stepValue(raw: string, direction: 1 | -1, { min, max, step, clearable }: StepLimits): string {
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    if (direction < 0) return clearable ? "" : raw;
    if (min !== undefined && (min > 0 || step !== "any")) return String(min);
    return "1";
  }
  const size = step === "any" ? adaptiveStep(value, direction) : step;
  const next = Math.round((value + direction * size) * 1e6) / 1e6;
  // Une zone de 0 ne veut rien dire : seul le pas libre s'arrête avant 0.
  const belowRange = (step === "any" && next <= 0) || (min !== undefined && next < min);
  if (direction < 0 && clearable && belowRange) return "";
  if (min !== undefined && next < min) return String(min);
  if (max !== undefined && next > max) return String(max);
  return String(next);
}

const limitsOf = (input: HTMLInputElement): StepLimits => ({
  min: input.min === "" ? undefined : Number(input.min),
  max: input.max === "" ? undefined : Number(input.max),
  step: input.step === "any" || input.step === "" ? "any" : Number(input.step),
  clearable: input.dataset.clearable !== undefined,
});

function stepButton(input: HTMLInputElement, direction: 1 | -1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "step";
  button.textContent = direction > 0 ? "+" : "−";
  button.setAttribute("aria-label", t(direction > 0 ? "stepper.more" : "stepper.less"));
  // Le clavier passe par le champ et ses flèches : les boutons servent à la souris et au doigt.
  button.tabIndex = -1;

  const step = () => {
    input.value = stepValue(input.value, direction, limitsOf(input));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  let delay: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;
  let pressed = false;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
    if (!pressed) return;
    pressed = false;
    // À la fin seulement : une limite enregistrée dans la salle n'a pas à l'être à chaque cran.
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pressed = true;
    step();
    delay = setTimeout(() => {
      repeat = setInterval(step, HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  });
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("pointercancel", stop);
  return button;
}

function enhance(input: HTMLInputElement) {
  if (input.parentElement?.classList.contains("stepper")) return;
  const wrapper = document.createElement("span");
  wrapper.className = "stepper";
  input.replaceWith(wrapper);
  wrapper.append(stepButton(input, -1), input, stepButton(input, 1));
}

/** Tous les champs numériques de ce conteneur reçoivent − et +, y compris ceux qui apparaîtront ensuite. */
export function watchSteppers(root: HTMLElement) {
  const apply = () => root.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach(enhance);
  apply();
  new MutationObserver(apply).observe(root, { childList: true, subtree: true });
}
