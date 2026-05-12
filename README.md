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
