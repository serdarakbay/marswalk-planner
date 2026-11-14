# Veri sözleşmeleri

`web/data/` altındaki her dosyanın tam şeması. Sahibi: Ege. Şema değişikliği gerekiyorsa önce Ege'ye söyle; kendi dosyanın şemasını tek başına değiştirme, çünkü başkası okuyor.

## Genel kurallar

- Noktalar her zaman **`[lon, lat]`** (doğu pozitif, planetosentrik). Bbox her zaman `{west, south, east, north}`.
- Birim alan adında yazar: `_m`, `_min`, `_deg`, `_mSv`, `_pct`, `_c`. Tabloda birimsiz geçen eski alanlar (`sun_az`, `sun_el`, `earth_el`) derece cinsindendir ve adları değişmez.
- Saatler: UTC `"2026-11-15T12:46:05Z"` (ISO 8601, `Z` ile), Mars yerel saati `"HH:MM"` (LMST).
- **Fazladan alan serbesttir**, okuyan taraf tanımadığı alanı yok sayar. Bu dosyada yazan alanlar ise zorunludur; değeri bilinmiyorsa `null` yazılır, alan silinmez.
- Mock dosyalar gerçek veriyle **aynı isim ve aynı şemayla** yazılır. Mock olduğu belli olsun diye nesne kökünde `"source": "MOCK"` önerilir.
- Frontend her dosyanın eksik ya da bozuk olabileceğini varsayar (`state.x === null`).

`main.js`'teki `state` anahtarları ve dosya yolları:

| `state` anahtarı | Dosya | Sahibi |
|---|---|---|
| `area` | `web/data/area.json` | Utku |
| `layers` | `web/data/layers.json` | Ege |
| `overlays` | `web/data/overlays.json` | Demir |
| `route` | `web/data/route.geojson` | Demir |
| `summary` | `web/data/summary.json` | Demir |
| `safety` | `web/data/safety/safety.json` | Utku |
| `stops` | `web/data/stops.json` | Utku |
| `geology` | `web/data/geology.geojson` | Utku |
| `images` | `web/data/images.json` | Egemen |
| `traverse` | `web/data/traverse.geojson` | Egemen |
| `weather` | `web/data/weather.json` | Egemen |
| `sun` | `web/data/sun.json` | Serdar |
| `eva` | `web/data/eva_window.json` | Serdar |
| `donki` | `web/data/donki.json` | Utku |
| `radiation` | `web/data/radiation.json` | Utku |
| `alerts` | `web/data/alerts.json` | Utku |

`config/mission.json` (Utku) frontend'e yüklenmez; Python script'lerinin ortak girdisidir. Şeması en altta.

---

## area.json (Utku)

```json
{
  "bbox": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73},
  "habitat": [137.385, -4.755],
  "crs": "+proj=longlat +R=3396190 +no_defs"
}
```

- `habitat` bbox'ın **içinde** olmalı. Yukarıdaki koordinat sadece örnek; gerçeğini Utku belirler.

## layers.json (Ege)

Altlık katmanları (Mars Trek WMTS).

```json
[
  {
    "id": "ctx",
    "name": "CTX mosaic",
    "type": "base",
    "url": "https://trek.nasa.gov/tiles/Mars/EQ/<Layer>/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
    "fallbackUrl": "tiles/ctx/{z}/{y}/{x}.jpg",
    "format": "jpg",
    "maxNativeZoom": 17,
    "attribution": "NASA/JPL-Caltech/MSSS, Mars Trek"
  }
]
```

- `type`: `"base"` (tek seçilir) ya da `"overlay"` (üst üste açılabilir).
- `format`: `"jpg"` ya da `"png"`. `fallbackUrl` yoksa `null`.

## overlays.json (Demir)

Önceden üretilmiş PNG katmanları (eğim, maliyet, ...).

```json
[
  {
    "id": "slope",
    "name": "Slope",
    "png": "data/overlays/slope.png",
    "bounds": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73},
    "legend": [
      {"color": "#4fb37a", "label": "< 15°"},
      {"color": "#e8b43a", "label": "15–25°"},
      {"color": "#e5484d", "label": "> 25°"}
    ]
  }
]
```

- `png` yolu `web/`'e göre görelidir. `bounds`, PNG'nin warp edildiği sınırlarla **birebir** aynı olmalı.
- `legend` boş olabilir (`[]`).

## route.geojson (Demir)

```json
{
  "type": "Feature",
  "geometry": {"type": "LineString", "coordinates": [[137.385, -4.755], [137.386, -4.754]]},
  "properties": {
    "slope_deg": [0, 4.2],
    "t_min": [0, 1.8]
  }
}
```

- `slope_deg[i]` ve `t_min[i]` koordinat `i` ile eşleşir; dizilerin boyu koordinat sayısıyla aynıdır.
- `t_min` başlangıçtan itibaren birikimli süredir.

## summary.json (Demir)

```json
{
  "distance_m": 2140,
  "duration_min": 185,
  "o2_used_pct": 41.5,
  "dose_mSv": 0.08,
  "max_slope_deg": 18.3,
  "profile": [{"d": 0, "z": -4512.0, "slope": 0}, {"d": 25, "z": -4510.4, "slope": 3.7}]
}
```

- `profile`: `d` metre (başlangıçtan mesafe), `z` metre (Mars areoid'ine göre yükseklik), `slope` derece.

## safety/safety.json (Utku)

```json
{
  "overlays": [
    {"id": "comm_shadow", "name": "Radio shadow", "png": "data/safety/comm_shadow.png",
     "bounds": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73}, "legend": []}
  ],
  "shelters": [{"coord": [137.381, -4.751], "svf": 0.62}],
  "route": [{"d": 0, "comm_ok": true, "shelter_min": 4.5}],
  "offline_min": 12
}
```

- `overlays[]` şeması `overlays.json` ile aynıdır; katman paneli ikisini birlikte gösterir.
- `svf`: sky-view factor, 0–1. `route[].d` metre, `summary.json` profilindeki `d` ile aynı eksen.
- `offline_min`: rota boyunca toplam haberleşmesiz süre.

## stops.json (Utku)

```json
[
  {
    "id": "s1",
    "name": "Boxwork ridge",
    "coord": [137.383, -4.752],
    "science": "Calcium sulfate veins left by groundwater...",
    "photos": [{"url": "https://mars.nasa.gov/msl-raw-images/...jpg", "sol": 4500, "camera": "MAST_LEFT", "credit": "NASA/JPL-Caltech/MSSS"}]
  }
]
```

- Duraklar rota sırasıyla listelenir. `stop:select` olayının `detail` değeri bu nesnelerden biridir.

## geology.geojson (Utku)

```json
{
  "type": "FeatureCollection",
  "features": [
    {"type": "Feature",
     "geometry": {"type": "Polygon", "coordinates": [[[137.36, -4.77], [137.37, -4.77], [137.37, -4.76], [137.36, -4.77]]]},
     "properties": {"unit": "Hmm", "name": "Mount Sharp group", "note": "..."}}
  ]
}
```

## images.json (Egemen)

```json
[
  {"url": "https://mars.nasa.gov/msl-raw-images/...jpg", "sol": 4500, "camera": "MAST_LEFT",
   "utc": "2025-04-01T10:22:00Z", "site": 110, "drive": 1240, "credit": "NASA/JPL-Caltech/MSSS"}
]
```

## traverse.geojson (Egemen)

Curiosity'nin bbox içindeki rotası. Tek bir LineString `Feature` ya da rota parçalarından oluşan bir `FeatureCollection` olabilir; okuyan taraf ikisini de kabul eder.

```json
{
  "type": "FeatureCollection",
  "features": [
    {"type": "Feature",
     "geometry": {"type": "LineString", "coordinates": [[137.383458, -4.730024], [137.384, -4.7305]]},
     "properties": {"sol_start": 2468, "sol_end": 2824, "source": "MSL traverse, NASA/JPL-Caltech (MMGIS)"}}
  ]
}
```

- Her parça bir `LineString`. `properties` içindeki `sol_start`, `sol_end` ve `source` önerilir, zorunlu değil.

## weather.json (Egemen)

```json
{
  "source": "REMS",
  "rows": [{"lmst": "06:00", "temp_c": -78.0}, {"lmst": "14:00", "temp_c": -8.0}]
}
```

- `rows` LMST'ye göre sıralı. Serdar'ın EVA penceresi bu dosyayı okur (yoksa kendi MOCK eğrisine düşer).

## sun.json (Serdar)

```json
{
  "source": "JPL Horizons (airless apparent az/el) + Mars24 LMST",
  "observer": {"lon": 137.385, "lat": -4.755, "from": "area.json"},
  "step_min": 10,
  "rows": [
    {"utc": "2026-11-15T00:00:00Z", "lmst": "21:48", "sun_az": 278.63, "sun_el": -50.4, "earth_el": -13.87, "light_time_min": 10.95}
  ]
}
```

- `sun_az` kuzeyden saat yönünde derece; `sun_el`, `earth_el` derece. Horizons'a ulaşılamazsa `earth_el` ve `light_time_min` `null` olur.
- `observer.from`: `"area.json"` ya da `"fallback"`.

## eva_window.json (Serdar)

```json
{
  "start_lmst": "10:13",
  "end_lmst": "17:22",
  "reason": "Start limited by temperature -40 C; end limited by Sun elevation 15 deg.",
  "start_utc": "2026-11-15T12:46:05Z",
  "end_utc": "2026-11-15T20:06:20Z",
  "duration_min": 440,
  "temp_source": "MOCK"
}
```

- Zorunlu alanlar: `start_lmst`, `end_lmst`, `reason`. Pencere yoksa ilk ikisi `null`.

## donki.json (Utku)

```json
{
  "mode": "replay",
  "events": [{"type": "FLR", "start": "2024-05-20T05:00:00Z", "peak": "2024-05-20T05:22:00Z", "mars_impact": true}]
}
```

- `mode`: `"live"` ya da `"replay"`. Replay her zaman 20 Mayıs 2024 olayıdır.
- `type`: DONKI olay tipi (`FLR`, `CME`, `SEP`, ...).

## radiation.json (Utku)

```json
{
  "base_mSv_per_day": 0.64,
  "event_multiplier": 1.0,
  "status": "nominal",
  "message": "Background GCR only."
}
```

- `status`: `"nominal"`, `"elevated"` ya da `"storm"`.

## alerts.json (Utku)

```json
{
  "rules": [
    {"id": "o2_low", "metric": "o2_remaining_pct", "op": "<", "value": 25, "level": "danger", "text": "O2 reserve reached. Return to habitat."}
  ]
}
```

- `op`: `<`, `<=`, `>`, `>=`, `==`. `level`: `info`, `warn` ya da `danger` (renkler `base.css`'teki `--color-info`, `--color-warn`, `--color-danger`).
- `metric` adları HUD'un hesapladığı değerlerdir: `o2_remaining_pct`, `dose_mSv`, `slope_deg`, `comm_ok`, `shelter_min`.

---

## config/mission.json (Utku)

Tüm eşik ve sabitler. Python script'leri buradan okur, kodda sihirli sayı olmaz.

```json
{
  "gravity_m_s2": 3.71,
  "slope_warn_deg": 15,
  "slope_max_deg": 25,
  "eva_nominal_hours": 8,
  "eva_min_sun_el_deg": 15,
  "eva_min_temp_c": -40,
  "o2_reserve_pct": 25,
  "rad_base_mSv_per_day": 0.64,
  "dem_resolution_m": 1,
  "dem_max_downsample_m": 2
}
```

- `eva_min_sun_el_deg` ve `eva_min_temp_c` Serdar'ın EVA penceresi için gerekir.
