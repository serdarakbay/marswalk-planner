# CLAUDE.md: Martian Map (NASA Space Apps 2026)

Bu dosya, repoda çalışan herkes ve onların Claude oturumları için tek doğru kaynaktır. Burada yazmayan bir kural için önce Ege'ye sor.

## Proje

Challenge: **Interplanetary Survival Guide: Martian Map**. Gale kraterinde, Curiosity'nin incelediği boxwork bölgesinde bir astronot yürüyüşü (Marswalk) için şunları birleştiren web uygulaması yapıyoruz:

- katmanlı harita (optik, termal, spektral, jeoloji)
- güvenli rota (eğim, pürüzlülük, O2 ve radyasyon bütçesi)
- durak kartları (Curiosity fotoğrafları + bilim notu)
- HUD modu (vizör görünümü: sıradaki durak, kalan O2 ve doz, uyarılar)

- **Kod dondurma:** Pazar 15 Kasım 12:00 (İstanbul). Bu saatten sonra sadece bug fix yapılır.
- **Teslim hedefi:** Pazar 18:00. Teslim sistemi 23:59'da kapanıyor.
- **Language:** Code, comments, documentation, commit messages, UI text, the project page and slides are all in **English**.

## Çalışma alanı

```json
{"bbox": {"west": 137.36, "south": -4.77, "east": 137.40, "north": -4.73}}
```

- Yaklaşık 2,4 × 2,4 km (Mars'ta 1° ≈ 59,2 km).
- Boylam doğu pozitif, enlem planetosentrik (Mars Trek ile aynı).
- Habitat noktasını `web/data/area.json`'da Utku belirler. Kodda sabit koordinat yazma, her zaman `area.json`'dan oku.

## Ekip ve sahiplik

Çalışmaya başlamadan önce kullanıcının hangi ekip üyesi olduğunu belirle (branch adından ya da doğrudan sorarak). **Sadece o kişinin sahibi olduğu dosyaları düzenle.**

| Kişi | Rol | Branch | Yazabileceği yerler |
|---|---|---|---|
| Ege | Servisler, Harita, Entegrasyon | `harita` | `web/index.html`, `web/js/main.js`, `web/js/map/`, `web/css/base.css`, `web/assets/`, `CLAUDE.md`, `.gitignore`, `.github/`, `.claude/settings.json`, `.env.example`, `README.md` |
| Demir | Arazi ve Rota | `arazi` | `arazi/`, `web/data/overlays/`, `web/data/overlays.json`, `web/data/route.geojson`, `web/data/summary.json` |
| Egemen | Veri: Curiosity ve REMS + durak kartları | `veri` | `pipeline/fetch/curiosity.py`, `pipeline/fetch/rems.py`, `web/data/images.json`, `web/data/traverse.geojson`, `web/data/weather.json`, `web/js/cards/`, `web/css/cards.css` |
| Serdar | Horizons, EVA penceresi, HUD | `hud` | `pipeline/fetch/horizons.py`, `science/eva/`, `web/data/sun.json`, `web/data/eva_window.json`, `web/js/hud/`, `web/css/hud.css` |
| Utku | Bilim, Güvenlik katmanları, Radyasyon, Hikâye | `harita`, `bilim` | `science/` (`science/eva/` hariç, `science/safety/` dahil), `config/`, `docs/story/`, `docs/contracts.md`, `requirements.txt`, `pipeline/common.py`, `pipeline/fetch/trek.py`, `pipeline/fetch/tiles.py`, `pipeline/fetch/donki.py`, `pipeline/fetch/usgs.py`, `web/tiles/`, `web/data/safety/`, `web/data/` içinde: `area.json`, `layers.json`, `stops.json`, `donki.json`, `radiation.json`, `alerts.json`, `geology.geojson` |

**Mocks:** Utku writes all mock files under `web/data/`. When the real file is ready, its owner's script overwrites the mock.

**Veri sahipliği kuralı:** Ham veriyi tek kişi indirir; aynı verinin farklı ürünlerini iki kişi üretebilir, ama her çıktı dosyasının tek yazarı vardır. Başka biri o veriye ihtiyaç duyarsa sahibin ara çıktısını ya da `web/data/` dosyasını okur, API'yi kendisi çağırmaz.

- USGS DEM → sadece Demir indirir. Kestiği `data/cache/dem_clip.tif`'i Drive'dan Utku'yla paylaşır. Demir bu DEM'den eğim, maliyet ve rota; Utku radyo gölgesi, sığınak ve `safety.json` üretir. Overlay PNG'lerini ikisi de `arazi/geo.py` içindeki `to_overlay_png()` ile üretir (Utku sadece import eder, değiştirmez); böylece katmanlar birebir hizalanır.
- Mars Trek WMTS and tile cache → Utku only
- Curiosity ham görüntüleri, MSL traverse, REMS → sadece Egemen
- JPL Horizons → sadece Serdar
- DONKI ve USGS jeolojik harita → sadece Utku

`requirements.txt` at the repo root and `pipeline/common.py` (shared helpers that read `area.json`) belong to Utku. If you need a new Python package, tell Utku.

Başkasının dosyasında değişiklik gerekiyorsa düzenleme. Kullanıcıya "bu dosya X'in, ona şunu iletmen gerekiyor" de ve gereken değişikliği metin olarak öner.

## Klasör yapısı

```
pipeline/
  common.py            Utku: reads area.json, shared helpers
  fetch/trek.py        Utku: Mars Trek layers → layers.json
  fetch/tiles.py       Utku: backup tile cache → web/tiles/
  fetch/curiosity.py   Egemen: ham görüntüler + traverse
  fetch/rems.py        Egemen: sıcaklık eğrisi
  fetch/horizons.py    Serdar: Güneş/Dünya açıları, LMST
  fetch/donki.py       Utku: güneş olayları (live + replay)
  fetch/usgs.py        Utku: USGS jeolojik birimleri → geology.geojson
arazi/                 Demir: DEM işleme, eğim, maliyet, rota, geri dönüş halkaları
arazi/geo.py           Demir: to_overlay_png() — Utku da import eder
science/               Utku: models.py (O2, doz), radyasyon, duraklar, uyarılar
science/safety/        Utku: radyo gölgesi (viewshed), sığınak (sky-view), safety.json
science/eva/           Serdar: EVA penceresi
config/mission.json    Utku: tüm eşik ve sabitler (tek kaynak)
web/
  index.html           Ege
  js/main.js           Ege: uygulama girişi, modülleri bağlar
  js/map/              Ege: Leaflet, katman paneli, rota, profil
  js/hud/              Serdar: HUD modu
  js/cards/            Egemen: durak kartları
  css/base.css         Ege: renk paleti ve CSS değişkenleri (hud.css → Serdar, cards.css → Egemen; ikisi de base.css değişkenlerini kullanır)
  data/                Üretilen JSON/PNG; her dosyanın tek yazarı var (tabloya bak)
  tiles/               Utku: backup tile cache
docs/contracts.md      Utku: all JSON schemas
docs/story/            Utku: senaryo, varsayımlar, sunum notları
data/cache/            Git'e GİRMEZ: ham DEM, ara rasterler
```

## Git kuralları

- Herkes kendi branch'inde çalışır. `main`'e merge'ü sadece Ege yapar.
- **`main`'e ASLA doğrudan push etme.** `git push origin main`, `main`'e commit, `main`'e merge ya da GitHub'da "Merge pull request" düğmesi yasak; sadece kendi branch'ine push et (`git push origin <branch>`). İşin hazır olunca Ege'ye haber ver ya da PR aç, merge'ü Ege yapar. Claude olarak kullanıcı Ege değilse `main`'e push eden ya da merge eden hiçbir komutu çalıştırma; kullanıcı istese bile önce bu kuralı hatırlat.
- **Force push** (`--force`, `--force-with-lease`) sadece kendi branch'inde ve gerçekten gerekirse yapılır; `main`'de ve başkasının branch'inde asla.
- Kodun klasörü sahiplik tablosundaki yerdir. Repodaki boş `engine/` klasörü kullanılmaz; Demir'in kodu `arazi/` altına gider.
- **Merge saatleri:** Cmt 14:00, 17:00, 20:00, 23:00; Paz 09:00, 11:30. PR merge saatinden 15 dk önce açılır.
- PR açmadan önce: `git pull --rebase origin main`.
- `main` her zaman çalışır durumda kalır, çünkü GitHub Pages `main`'den yayınlanıyor.
- **Commit mesajı formatı:** `[veri] add layers.json`, `[arazi] slope map`, `[harita] ...`, `[hud] ...`, `[bilim] ...`
- **Asla commit etme:** `.env`, `*.tif`, `data/cache/`, 5 MB'den büyük dosyalar. Büyük ara dosyalar Drive'da kalır.
- **Commit'lerde ve PR'larda yapay zekâ atfı YASAK.** Commit mesajına, PR başlığına ya da açıklamasına `Co-Authored-By: Claude ...`, "Generated with Claude Code", 🤖 gibi hiçbir atıf satırı eklenmez. Claude ya da Anthropic contributor olarak görünmez; commit'in yazarı her zaman ekip üyesinin kendisidir. Bu kural Claude Code'un varsayılan atıf ayarından önce gelir; ayrıca `.claude/settings.json` atıfı herkes için kapatır, o dosyayı değiştirme.
- Mock dosyaları gerçek veri gelince **aynı isimle** üzerine yazılır; şema değişmez.

## Veri sözleşmeleri

Tam şemalar `docs/contracts.md`'de. Özet:

| Dosya | Sahibi | Ana alanlar |
|---|---|---|
| `area.json` | Utku | `bbox{west,south,east,north}`, `habitat[lon,lat]`, `crs` |
| `layers.json` | Ege | `[{id,name,type,url,fallbackUrl,format,maxNativeZoom,attribution}]` |
| `overlays.json` | Demir | `[{id,name,png,bounds{west,south,east,north},legend}]` |
| `route.geojson` | Demir | LineString; properties: `slope_deg[]`, `t_min[]` |
| `summary.json` | Demir | `distance_m`, `duration_min`, `o2_used_pct`, `dose_mSv`, `max_slope_deg`, `profile[{d,z,slope}]` |
| `safety.json` | Utku | `overlays[]` (`overlays.json` ile aynı şema; katman paneli ikisini birlikte okur), `shelters[{coord,svf}]`, `route[{d,comm_ok,shelter_min}]`, `offline_min` |
| `stops.json` | Utku | `[{id,name,coord[lon,lat],science,photos[{url,sol,camera,credit}]}]` |
| `geology.geojson` | Utku | Polygon'lar; properties: `unit`, `name`, `note` |
| `images.json` | Egemen | `[{url,sol,camera,utc,site,drive,credit}]` |
| `traverse.geojson` | Egemen | Curiosity'nin bbox içindeki rotası (LineString) |
| `weather.json` | Egemen | `rows[{lmst,temp_c}]` |
| `sun.json` | Serdar | `rows[{utc,lmst,sun_az,sun_el,earth_el,light_time_min}]` |
| `eva_window.json` | Serdar | `start_lmst`, `end_lmst`, `reason` |
| `donki.json` | Utku | `mode` (`live`/`replay`), `events[{type,start,peak,mars_impact}]` |
| `radiation.json` | Utku | `base_mSv_per_day`, `event_multiplier`, `status`, `message` |
| `alerts.json` | Utku | `rules[{id,metric,op,value,level,text}]` |

## Parçalar arası JS arayüzü

Harita, kartlar ve HUD birbirinin dosyasını import etmez; sadece şu arayüz üzerinden konuşur:

- `web/js/main.js` (Ege) tüm `web/data/` dosyalarını bir kez yükler ve tek bir `state` nesnesine koyar: `{area, layers, overlays, route, summary, safety, stops, geology, images, traverse, weather, sun, eva, donki, radiation, alerts}`. Eksik ya da bozuk dosya `null` kalır, uygulama çökmez.
- Harita (Ege) duraka tıklanınca: `document.dispatchEvent(new CustomEvent('stop:select', {detail: stop}))`
- Kartlar (Egemen): `web/js/cards/index.js` → `export function initCards(state, el)`; `stop:select` olayını dinler.
- HUD (Serdar): `web/js/hud/index.js` → `export function initHUD(state, el)`; H tuşu HUD'u açıp kapatır, `stop:select` ile sıradaki durağı günceller.
- HUD (Serdar) emits `document.dispatchEvent(new CustomEvent('hud:time', {detail}))` on every simulated clock step: `detail = {active, playing, utc, elapsed_min, coord: [lon, lat] | null, d_m | null}`. `coord` is null when there is no route. The map (Ege) listens and shows the astronaut marker; it hides the marker when `active` is false.
- `main.js` bu iki fonksiyonu çağırır. Başka global değişken yok.

### Sayfa yerleşimi: kimin kutusu nerede

`index.html` ve `base.css` sadece Ege'nindir. Serdar ve Egemen bu iki dosyayı **düzenlemez**; çakışma olmaması için sayfa baştan kutulara bölünmüştür:

| Kutu | Sahibi | Not |
|---|---|---|
| `#panel` | Ege | Katman paneli |
| `#map`, `#profile` | Ege | Leaflet haritası, yükseklik profili |
| `#cards` | Egemen | `initCards(state, el)` bu elemanı alır |
| `#hud-root` | Serdar | `initHUD(state, el)` bu elemanı alır; başta `hidden` |

- Her modül kendi DOM'unu kendi kutusunun içinde, JS ile kurar. `cards.css` `index.html`'de zaten bağlıdır; HUD kendi CSS'ini (`hud.css`) kendisi yükler.
- **CSS sınırı:** `hud.css`'teki her seçici `#hud-root` ile, `cards.css`'teki her seçici `#cards` ile başlar. `html`, `body`, `*`, çıplak etiket seçicileri ve `.leaflet-*` sınıfları sadece `base.css`'te olur.
- Renk, font, boşluk, köşe ve z-index için sadece `base.css` değişkenleri (`var(--...)`) kullanılır; sabit hex ya da sayı yazılmaz. Yeni bir değişken gerekirse Ege'ye söylenir.
- Katman sırası: `--z-map` < `--z-panel` < `--z-cards` < `--z-hud`.
- **HUD modu:** HUD açılınca `document.body.dataset.mode = 'hud'`, kapanınca `'map'` yapar. Bu değeri sadece HUD yazar; HUD modunda neyin gizleneceğini `base.css` belirler (`body[data-mode="hud"]`).
- Başlıktaki HUD düğmesi `document.dispatchEvent(new CustomEvent('hud:toggle'))` yollar. H tuşunu ve `hud:toggle` olayını HUD dinler. Harita tek harfli klavye kısayolu kullanmaz.
- `main.js` modülleri `import()` ile yükler. `web/js/cards/index.js` ya da `web/js/hud/index.js` yoksa ya da hata atarsa konsola yazar, sayfa açılmaya devam eder.
- Bunlar yetmezse `index.html`'i düzenleme; Ege'den iste.

## Karar saatleri (yarım kalmasın)

Riskli her işin bir karar saati var; o saatte çalışmıyorsa B planına geçilir. Tam liste ekip planında, özet:

| İş | Sahibi | Karar | B planı |
|---|---|---|---|
| 1 m DEM kapsaması | Demir | Cmt 13:30 | HiRISE DTM ya da bbox kaydırma |
| MSL traverse | Egemen | Cmt 13:30 | Mars Trek'ten elle 10–15 nokta |
| Curiosity görüntü API'si | Egemen | Cmt 14:30 | Raw Images sitesinden elle 8–10 URL |
| Horizons Mars yüzeyi | Serdar | Cmt 14:30 | Mars24 algoritmasıyla analitik Güneş açısı |
| USGS GeoJSON | Utku | Cmt 16:00 | Bırakılır, Trek jeoloji katmanı kalır |
| REMS | Egemen | Cmt 16:30 | Tipik günlük eğri, "yaklaşık" etiketli |
| Rota | Demir | Cmt 19:30 | 2 m DEM; olmazsa düz çizgi + eğim uyarısı |
| `gdal_viewshed` / rvt-py | Utku | Cmt 19:30 | numpy ile 8 yönde ufuk açısı ve basit görüş hattı; olmazsa sadece radyo gölgesi |
| Uçtan uca demo | Ege | Cmt 23:30 | Ek modüller iptal, herkes entegrasyona |
| HUD tamamı | Serdar | Paz 03:00 | 23:00'teki HUD MVP |

30 dakikadan fazla aynı sorunda takılırsan gruba yaz. Claude olarak, kullanıcı karar saatini geçmiş bir işte takılıyorsa B planını hatırlat.

## Koordinat ve birim kuralları

- JSON'da noktalar her zaman **[lon, lat]** sırasında (GeoJSON standardı).
- Bbox her zaman isimli alanlarla yazılır: `{west, south, east, north}`. Dizi halinde bbox kullanma.
- Leaflet [lat, lon] bekler. Dönüşüm sadece `web/js/map/geo.js` içindeki `toLatLng()` helper'ında yapılır.
- Birim alan adında yazar: `_m`, `_min`, `_deg`, `_mSv`, `_pct`, `_c`. Gy (emilen doz) ile Sv (doz eşdeğeri) asla karıştırılmaz.
- Mars CRS (rasterio/pyproj):
  - Coğrafi: `+proj=longlat +R=3396190 +no_defs` (PROJ destekliyorsa `IAU_2015:49900`)
  - Metrik hesap: `+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs`
- **Eğim, mesafe, maliyet her zaman metre cinsinden projeksiyonlu gridde hesaplanır.** Sadece görselleştirme PNG'si coğrafi grid'e warp edilir. PNG sınırları `overlays.json`'daki `bounds` ile birebir aynı olmalı.

## Görev sabitleri

Tüm eşikler `config/mission.json`'dan okunur. Kodda sihirli sayı yazma. Başlangıç değerleri (Utku değiştirebilir):

```json
{
  "gravity_m_s2": 3.71,
  "slope_warn_deg": 15,
  "slope_max_deg": 25,
  "eva_nominal_hours": 8,
  "o2_reserve_pct": 25,
  "rad_base_mSv_per_day": 0.64,
  "dem_resolution_m": 1,
  "dem_max_downsample_m": 2
}
```

- O2 modeli `science/models.py` içinde. Demir import eder, kendi modelini yazmaz.
- Varsayımların hepsi `docs/story/assumptions.md`'ye yazılır; sunumda açıkça gösterilecek.

## Teknik yığın

- **Python 3.11:** `rasterio`, `numpy`, `scikit-image` (`MCP_Geometric`, `route_through_array`), `pyproj`, `requests`, `python-dotenv`. GDAL CLI (`gdalwarp`, `gdal_viewshed`).
- **Frontend:** Build adımı olmayan düz HTML + ES modules, Leaflet, Chart.js (CDN). GitHub Pages `web/` klasöründen yayınlanır.
- **Mars Trek tile'ları:** Harita `crs: L.CRS.EPSG4326` ile kurulur. URL sırası `{z}/{y}/{x}` (TileMatrix/TileRow/TileCol, x ve y ters):
  ```
  https://trek.nasa.gov/tiles/Mars/EQ/<Layer>/1.0.0/default/default028mm/{z}/{y}/{x}.jpg
  ```
  Uzantı katmana göre jpg ya da png. Bunun için `layers.json`'daki `format` alanını kullan.

## Yapılacaklar ve yapılmayacaklar

- **Tarayıcıdan dış API çağırma.** Horizons, Curiosity ham görüntü API'si ve DONKI Python script'leriyle önceden çekilip `web/data/`'ya JSON olarak yazılır (CORS ve key güvenliği). İstisna sadece Mars Trek tile'ları ve fotoğraf URL'leri (img olarak).
- **API key asla JS'e ya da repoya girmez.** Key `.env`'de durur, `.env.example` repoda olur. GitHub Pages statik olduğu için JS'teki her key herkese açıktır.
- **Her script tekrar çalıştırılabilir olmalı:** `python -m pipeline.fetch.donki` gibi, girdi `area.json` ve `config/mission.json`, çıktı `web/data/`.
- **Canlı veri boş gelebilir.** DONKI için her zaman `replay` modu (20 Mayıs 2024 olayı, Curiosity RAD 8.100 µGy) çalışır durumda olmalı.
- **DEM'de NoData boşlukları** maliyet haritasında geçilmez (`inf`) sayılır, 0 değil.
- **Fotoğraflar indirilmez,** URL ile gösterilir. Her fotoğrafta kredi görünür: "NASA/JPL-Caltech" (Mastcam için "NASA/JPL-Caltech/MSSS").
- **Frontend her `web/data/` dosyası eksik ya da bozuk olsa da açılmalı.** Hatayı konsola yaz, arayüzü çökertme.
- **Kod dondurmadan sonra** yeni özellik, yeni bağımlılık ya da şema değişikliği yok.

## Komutlar

```bash
# Python ortamı
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # NASA_API_KEY=...

# Services (Utku)
python -m pipeline.fetch.trek
python -m pipeline.fetch.tiles

# Veri (Egemen)
python -m pipeline.fetch.curiosity
python -m pipeline.fetch.rems

# Horizons ve EVA (Serdar)
python -m pipeline.fetch.horizons
python -m science.eva.build

# Arazi (Demir)
python -m arazi.fetch_dem
python -m arazi.build_overlays
python -m arazi.route

# Bilim (Utku)
python -m pipeline.fetch.donki
python -m pipeline.fetch.usgs
python -m science.safety.build    # dem_clip.tif + route.geojson gerekir
python -m science.build_all

# Yerel önizleme: herkes kendi bilgisayarında, kendi branch'ini görür
python -m http.server 8000 -d web      # → http://localhost:8000
```

- `file://` ile açma: ES modules ve `fetch('data/...')` çalışmaz, yerel server şart.
- Ortak ve güncel sürüm GitHub Pages'tir (`main`). Paylaşılan link her zaman Pages linkidir.
- Merge öncesi entegrasyon kontrolü gerekirse Ege kendi makinesinde `python -m http.server 8000 -d web --bind 0.0.0.0` açar, diğerleri `http://<Ege'nin IP'si>:8000` ile bakar. Bu sadece geçici bakış içindir; hackathon Wi-Fi'ı cihazlar arası erişimi engelleyebilir.

## Bağlantılar

- Challenge sayfası ve kaynaklar: Mars Trek (trek.nasa.gov/mars), USGS Planetary Geologic Mapping, Curiosity Raw Images
- Mars Trek API: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
- JPL Horizons API: https://ssd-api.jpl.nasa.gov/doc/horizons.html
- DONKI: https://api.nasa.gov (DONKI bölümü)
- PDS Imaging: https://pds-imaging.jpl.nasa.gov
- Ekip planı (görevler ve saatler): https://claude.ai/artifact/1wpy7V7LKhvZvTu8fTajC1
