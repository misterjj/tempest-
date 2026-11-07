# Tempest! for Owlbear Rodeo

**Weather, light and mood for your scenes.** Rain, snow, fog, sand and embers on a whole scene or a single map or
shape, a time-of-day slider, screen filters, and one-click mood presets. The GM sets everything; players just see
it, and can turn effects off on their own screen.

*Work in progress.*

## Development

```sh
pnpm install
pnpm test
pnpm dev
```

Add the custom extension `http://localhost:5175/manifest.json` in Owlbear Rodeo, then enable it in the room.

### Architecture

- `src/state.ts`: the only shared data, one object in the scene metadata (`com.tempest/state`), written by the GM.
- `src/render/`: each client reads that state and draws its own local GPU effects (weather, then time of day and
  filters as post-processing). Only the state goes over the network.
- `src/local.ts`: per-browser settings (quality, mute).
- `src/panel/`: the toolbar panel (GM: moods, weather, time, filters; players: mute and quality).
- `src/background.ts`: starts the renderer and adds the "Add weather" context menu.

## Licence

[MIT](LICENSE).
