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

- `src/state.ts`: the shared settings, one object in the scene metadata (`com.tempest/state`), written by the GM:
  weather effects (each on a zone), and time of day and filters per zone. Kept under 4 KB.
- `src/zones.ts`: the zones painted by the GM (brush, rectangle, circle, eraser), under their own key
  (`com.tempest/zones`), written only while painting. Up to 8 zones of 150 shapes, about 20 KB at most.
- `src/render/`: each client reads that state and draws its own local GPU effects (weather, then time of day and
  filters as post-processing). Only the state goes over the network.
- `src/local.ts`: per-browser settings (quality, mute).
- `src/panel/`: the toolbar panel (GM: moods, weather, time, filters; players: mute and quality).
- `src/background.ts`: starts the renderer and adds the "Add weather" context menu.

## Guide site

`index.html` (English) and `fr/index.html` (French) are the guide site, served at the root of the deployment
(`src/guide/`). Links still to fill in: `LINKS` at the top of `src/guide/guide.ts` (store, Patreon).

Videos go in `public/guide/media/`, muted H.264 MP4, 16:9, under 2 MB each. Until a file exists, its frame shows the
expected name (and the comparisons show `placeholder-map.jpg` with fake rain).

| File | Section |
| --- | --- |
| `hero-on.mp4`, `hero-off.jpg` (or `.mp4`) | Opening comparison: same map and camera, with and without Tempest! |
| `moods.mp4` | Moods |
| `weather.mp4`, `weather-storm.mp4`, `weather-snow.mp4` | Weather |
| `zones.mp4` | Painted zones |
| `time.mp4`, `lamp-token.mp4`, `lamp-fixed.mp4` | Time of day and lights |
| `fluids.mp4`, `fluids-lava.mp4`, `fluids-hide.mp4` | Fluids |
| `filters.mp4`, `bursts.mp4`, `transition.mp4` | Filters and one-shot effects |
| `style-cartoon.mp4`, `style-realistic.mp4` | Realistic / cartoon comparison |

For a comparison, keep the camera still and record both versions with the same length: they are played in sync.

## Licence

[MIT](LICENSE).
