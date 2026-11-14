# Credits: UI and 3D libraries, repos and assets

Owner: Egemen (branch `veri`). Every library, repo or asset used in the stop cards
(`web/js/cards/`) and the 3D view (`web/js/view3d/`) is listed here with its licence.
The README credits are built from this file.

## Libraries

| Name | Version | Used in | Licence | Link |
|---|---|---|---|---|
| three.js (core + `OrbitControls` from `examples/jsm`) | 0.160.0, pinned, loaded from jsDelivr (`/npm/three@0.160.0/+esm`) | 3D view: terrain mesh, lights and shadows, camera controls | MIT | https://github.com/mrdoob/three.js |

No code was copied from other repositories. The stop cards use no external library.

## Data and imagery shown in the UI

| What | Where | Credit |
|---|---|---|
| HiRISE mosaic tiles draped on the 3D terrain | Mars Trek WMTS (`layers.json`, Utku) | NASA/JPL-Caltech/UArizona, NASA Mars Trek |
| Curiosity raw images on the stop cards | mars.nasa.gov raw image API (`images.json`) | NASA/JPL-Caltech (Mastcam, MAHLI: NASA/JPL-Caltech/MSSS) |
| Curiosity traverse | MSL MMGIS layers (`traverse.geojson`) | NASA/JPL-Caltech |
| REMS daily temperature | mars.nasa.gov REMS feed (`weather.json`) | NASA/JPL-Caltech/CAB(CSIC-INTA) |
