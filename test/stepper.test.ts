import { describe, expect, it } from "vitest";
import { stepValue } from "../src/panel/stepper";

describe("boutons − et +", () => {
  it("avance d'un pas fixe, sans erreur d'arrondi, entre les bornes", () => {
    const interval = { min: 0.2, step: 0.1 };
    expect(stepValue("0.2", 1, interval)).toBe("0.3");
    expect(stepValue("0.3", -1, interval)).toBe("0.2");
    expect(stepValue("0.2", -1, interval)).toBe("0.2");
    expect(stepValue("100", 1, { min: 1, max: 100, step: 1 })).toBe("100");
    expect(stepValue("1", -1, { min: 1, max: 100, step: 1 })).toBe("1");
  });

  it("adapte le pas à la grandeur quand il est libre", () => {
    const zone = { min: 0, step: "any" as const, clearable: true };
    expect(stepValue("0.5", 1, zone)).toBe("0.6");
    expect(stepValue("1", 1, zone)).toBe("1.5");
    expect(stepValue("1", -1, zone)).toBe("0.9");
    expect(stepValue("10", 1, zone)).toBe("11");
    expect(stepValue("10", -1, zone)).toBe("9.5");
  });

  it("démarre d'un champ vide au minimum, ou à 1", () => {
    expect(stepValue("", 1, { min: 0.2, step: 0.1 })).toBe("0.2");
    expect(stepValue("", 1, { min: 0, step: "any", clearable: true })).toBe("1");
    expect(stepValue("", 1, { min: 1, step: 1, clearable: true })).toBe("1");
    expect(stepValue("", -1, { min: 1, step: 1 })).toBe("");
    // À pas fixe, 0 est une vraie valeur : on y passe avant de revenir à vide.
    const direction = { min: 0, max: 360, step: 15, clearable: true };
    expect(stepValue("", 1, direction)).toBe("0");
    expect(stepValue("15", -1, direction)).toBe("0");
    expect(stepValue("0", -1, direction)).toBe("");
    expect(stepValue("345", 1, direction)).toBe("360");
  });

  it("revient à vide sous le minimum quand vide a un sens", () => {
    expect(stepValue("1", -1, { min: 1, step: 1, clearable: true })).toBe("");
    expect(stepValue("0.1", -1, { min: 0, step: "any", clearable: true })).toBe("");
    expect(stepValue("", -1, { min: 1, step: 1, clearable: true })).toBe("");
  });
});
