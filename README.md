# MURTAZA WhatsApp CRM Bot PoC

Amaç: ayrı WhatsApp Business test numarasıyla QR tabanlı, whitelist korumalı, mesaj kayıt odaklı PoC.

İlk güvenli kapsam:

- Baileys QR login
- gelen mesajları normalize etme
- whitelist dışına cevap vermeme
- tüm inbound mesajları kayıt modeline alma
- güvenli karşılama cevabı üretme
- Perfex/CRM write yok
- toplu mesaj yok
- production/VPS deploy yok

## Kurulum

Node 20+ gerekir. Bu makinede uygun sürüm varsa:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"
npm install
cp .env.example .env
npm test
npm run dev
```

QR çıktığında telefondan WhatsApp Business > Bağlı Cihazlar > Cihaz Bağla ile okutulur.

Bot QR üretince üç lokal çıktı yazar:

- `data/latest-qr.png` — en rahat okutulacak PNG görsel
- `data/latest-qr-terminal.txt` — terminal/TextEdit için blok QR
- `data/latest-qr.txt` — ham WhatsApp pairing payload

PNG açmak için:

```bash
open data/latest-qr.png
```

WhatsApp “birazdan tekrar dene” benzeri uyarı verirse botu açık bırakıp tekrar tekrar QR üretmesine izin verme. Process’i durdur, birkaç dakika bekle, sonra tek deneme yap. Kod 408 QR timeout sonrası otomatik reconnect etmez; bu, WhatsApp pairing rate-limit riskini azaltmak içindir.

## Güvenlik

İlk PoC whitelist modundadır. `BOT_WHITELIST_PHONES` dışında gelen mesajlar loglanır ama cevaplanmaz.

### Operatör paneli auth (2026-05-13 audit sonrası eklendi)

`http://127.0.0.1:8787` operatör paneli artık **Bearer token** zorunlu.

- Token kaynağı:
  1. `BOT_OPERATOR_TOKEN` env (16+ karakter); ya da
  2. `data/operator-token.txt` (chmod 600, ilk açılışta otomatik üretilir).
- Bot başlatıldığında console şunu yazar: `Operatör paneli hazır: http://127.0.0.1:8787/?token=<TOKEN>`
- `?token=` query string ile bir kez açılınca token sessionStorage'a düşer ve URL'den temizlenir.
- Tüm `/api/*` istekleri `Authorization: Bearer <TOKEN>` ister; eksik/yanlış olursa 401.
- `/` (HTML dashboard) kilitlenmemiştir; sadece API kilitlidir. Token'ı bilmeyen biri panel'i açabilir ama hiçbir veri çekemez/gönderemez.

**Neden eklendi:** Mac'te aynı user altında çalışan herhangi bir process (tarayıcı, başka CLI) `127.0.0.1:8787/api/send` ile WhatsApp mesajı gönderebiliyordu. Bearer token bu vektörü kapatır.

**Token rotasyonu:** `data/operator-token.txt` dosyasını sil → bot restart → yeni token üretilir.
