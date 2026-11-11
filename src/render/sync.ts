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
  /**
   * Effet attaché à un objet (STANDALONE de cette taille, coin haut gauche en x, y) : Owlbear le
   * déplace avec l'objet, même pendant un glisser. Sans lui, l'effet couvre l'écran (VIEWPORT).
   * Sa position ne compte qu'à la création : ensuite, c'est l'objet qui l'emmène.
   */
  attach?: { to: string; x: number; y: number; width: number; height: number };
}

/** Ce qui oblige à recréer l'effet : son code, et pour un effet attaché, son porteur et sa taille. */
const shapeOf = (effect: WantedEffect) =>
  effect.attach ? `${effect.sksl}\n${effect.attach.to}:${effect.attach.width}x${effect.attach.height}` : effect.sksl;

export class EffectSet {
  /** Code et réglages posés, par identifiant. */
  private placed = new Map<string, { sksl: string; uniforms: string }>();

  /** La scène a changé ou s'est rechargée : ses objets locaux ont disparu avec elle. */
  forget() {
    this.placed.clear();
  }

  async sync(wanted: WantedEffect[]) {
    const byId = new Map(wanted.map((effect) => [effect.id, effect]));
    const stale = [...this.placed.keys()].filter((id) => {
      const effect = byId.get(id);
      return !effect || shapeOf(effect) !== this.placed.get(id)!.sksl;
    });
    if (stale.length) await OBR.scene.local.deleteItems(stale);
    stale.forEach((id) => this.placed.delete(id));

    const add = wanted.filter((effect) => !this.placed.has(effect.id));
    if (add.length) {
      await OBR.scene.local.addItems(
        add.map((effect) => {
          const builder = buildEffect()
            .id(effect.id)
            .effectType(effect.attach ? "STANDALONE" : "VIEWPORT")
            .sksl(effect.sksl)
            .position(effect.attach ? { x: effect.attach.x, y: effect.attach.y } : { x: 0, y: 0 })
            .uniforms(effect.uniforms)
            .blendMode(effect.blend ?? "SRC_OVER")
            .layer(effect.layer)
            .zIndex(effect.zIndex ?? 0)
            .locked(true)
            .disableHit(true);
          if (effect.attach)
            builder
              .width(effect.attach.width)
              .height(effect.attach.height)
              .attachedTo(effect.attach.to)
              // Il suit l'objet sans grandir ni tourner, même caché. Il ne part pas avec lui :
              // c'est sync qui l'enlève ou l'attache ailleurs.
              .disableAttachmentBehavior(["SCALE", "ROTATION", "VISIBLE", "COPY", "LOCKED", "DELETE"]);
          return builder.build();
        }),
      );
    }
    add.forEach((effect) => this.placed.set(effect.id, { sksl: shapeOf(effect), uniforms: JSON.stringify(effect.uniforms) }));

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
