// Effets locaux tenus à jour d'après une liste voulue. Un shader ne se recompile que si son code
// change (zone repeinte, effet ajouté) ; sinon seuls ses réglages bougent, ce qui est rapide :
// les curseurs du panneau agissent en direct.

import OBR, { buildEffect, isEffect, type BlendMode, type Uniform } from "@owlbear-rodeo/sdk";

export interface WantedEffect {
  id: string;
  sksl: string;
  layer: "DRAWING" | "RULER" | "POST_PROCESS" | "CONTROL";
  uniforms: Uniform[];
  /** Mélange avec la carte ; SRC_OVER si absent. */
  blend?: BlendMode;
  /** Ordre dans le calque : un plus grand passe au-dessus. Absent : l'ordre choisi par Owlbear. */
  zIndex?: number;
}

export class EffectSet {
  /** Code et réglages posés, par identifiant. */
  private placed = new Map<string, { sksl: string; uniforms: string }>();

  /** La scène a changé ou s'est rechargée : ses objets locaux ont disparu avec elle. */
  forget() {
    this.placed.clear();
  }

  async sync(wanted: WantedEffect[]) {
    const byId = new Map(wanted.map((effect) => [effect.id, effect]));
    const stale = [...this.placed.keys()].filter((id) => byId.get(id)?.sksl !== this.placed.get(id)!.sksl);
    if (stale.length) await OBR.scene.local.deleteItems(stale);
    stale.forEach((id) => this.placed.delete(id));

    const add = wanted.filter((effect) => !this.placed.has(effect.id));
    if (add.length) {
      await OBR.scene.local.addItems(
        add.map((effect) =>
          buildEffect()
            .id(effect.id)
            .effectType("VIEWPORT")
            .sksl(effect.sksl)
            .position({ x: 0, y: 0 })
            .uniforms(effect.uniforms)
            .blendMode(effect.blend ?? "SRC_OVER")
            .layer(effect.layer)
            .zIndex(effect.zIndex ?? 0)
            .locked(true)
            .disableHit(true)
            .build(),
        ),
      );
    }
    add.forEach((effect) => this.placed.set(effect.id, { sksl: effect.sksl, uniforms: JSON.stringify(effect.uniforms) }));

    const retune = wanted.filter((effect) => {
      const placed = this.placed.get(effect.id)!;
      return !add.includes(effect) && placed.uniforms !== JSON.stringify(effect.uniforms);
    });
    if (retune.length) {
      await OBR.scene.local.updateItems(
        retune.map((effect) => effect.id),
        (items) => {
          for (const item of items) {
            const effect = byId.get(item.id);
            if (effect && isEffect(item)) item.uniforms = effect.uniforms;
          }
        },
      );
      retune.forEach((effect) => (this.placed.get(effect.id)!.uniforms = JSON.stringify(effect.uniforms)));
    }
  }
}
