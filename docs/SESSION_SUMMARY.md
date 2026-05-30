# SESSION_SUMMARY — murtaza-whatsapp-crm-bot

Son güncelleme: 2026-05-30 (medya Drive arşivleme + MURTAZA inbox fallback)

## 2026-05-30 — Gelen medya Drive arşivleme + atanmamış için MURTAZA inbox fallback

Commit `e32e6f3` (local, remote yok). Bot bu özellikle canlıda çalışıyor.

**Ne yapıldı:** Gelen görsel/video/ses/doküman yerel geçici dizine indirilir; sohbet müşteriye atanmışsa firmanın Drive'ına, atanmamışsa kullanıcının kendi Drive'ında `Work/MURTAZA/WhatsApp/Gelen-Kutusu/<gönderen>/<Tür>/` altına yüklenir (python `wa_drive_upload.py upload-inbox`). Başarılı upload → yerel kopya silinir, panelde Drive linki + tıklanır aç/indir menüsü (Drive'dan serve). Drive yüklemeleri seri kuyrukta.

- Drive auth: `~/.hermes/drive_token.json` (hesap **eipekyun@gmail.com**, kişisel — ESMARK değil).
- Klasör resolve: firma kartındaki Drive folder ID (firma) veya kök "Work" altında "MURTAZA" ensure (inbox).
- Kullanıcı kararları: gönderen-bazlı klasör; atama sonrası geçmiş inbox'ta kalır (taşıma yok).

**Adversarial review (4 lens / 21 bulgu) sonrası düzeltilen HIGH/MEDIUM:**
- HIGH whitelist guard: yalnızca whitelist gönderen medyası arşivlenir → status broadcast / tanımadık spam Drive'a yazamaz (canlıda kanıtlandı: story video'ları s=null kaldı)
- HIGH `/qr` + `/qr.png` auth guard + query-token desteği (img/QR sayfası Bearer header gönderemez) → açık QR ile hesap ele geçirme kapatıldı
- HIGH restart recovery: bekleyen+başarısız medya startup'ta `mediaArchiver.requeuePending()` ile kuyruğa
- markMediaPending duplicate-upsert guard; runUpload try-catch; find_folder `orderBy=createdTime` (duplicate race tutarlılık); grup JID `grup-` prefix; operator token artık log'a basılmaz
- **Atlanan (gerekçeli):** parent_id injection (FOLDER_ID_RE zaten `[A-Za-z0-9_-]` sınırlı), in-flight atama (kullanıcının "fallback'te kalsın" kararıyla uyumlu)

**Doğrulama:** tsc temiz, 52 test (44→52). Canlı end-to-end: gerçek +1 görseli `Gelen-Kutusu/905322013401/Görseller/3EB0A724…jpg`, panelden Drive serve HTTP 200 (1024x1024 jpeg). Panel tıklama ilk denemede çalışmadı = **tarayıcı cache** (sayfa yenileyince düzeldi, kod sorunu değil).

**Açık not (gelecek iş):** Medya arşivleme şu an SADECE whitelist (2 numara: +1 + Ersin). İleride müşteri sohbetleri (whitelist dışı, atanmış) eklenince guard genişletilmeli: "whitelist İÇİ VEYA sohbet bir firmaya atanmış".

## 2026-05-29 akşam — bot canlı + WhatsApp-benzeri panel (özet)

Bot, donmuş PoC'tan **VPS'te canlı çalışan, WhatsApp-benzeri operatör paneli** haline getirildi. 7 commit:

- `7e5e792` feat: panel uzaktan erişim (Tailscale bind + opsiyonel auth + `/qr`) + kişi/grup ismi + kendi mesajları
- `1dc0a60` fix: LID adresli sohbetleri telefon (PN) sohbetine birleştir
- `ebd474d` feat: tik (✓/✓✓/✓✓ mavi) + okunmamış UX + okundu makbuzu (per-numara) + panel-içi bağlantı/QR
- `97a4c1d` feat: rehber adı tam senkronu (app-state resync) + operatör öncelikli gecikmeli bot cevabı
- `f29da75` fix: bot devreye girme süresi saniyeye çevrildi + ayrı kart + kaydet/geri bildirim
- `08c483e` fix: 12 saat cevap-cooldown kaldırıldı + router karar logu
- `e188ac6` feat: gruplarda sadece dinleme (group_listen_only, çift güvenlik + test)

tsc temiz, 28 test geçiyor. Repo local-only (remote yok), `main` branch.

## Şu anki canlı durum

- **Çalışıyor:** VPS'te `node_modules/.bin/tsx src/index.ts` (setsid/detached). Panel `100.88.170.32:8787`. WhatsApp **+1 561 376 4604** ile bağlı.
- **Erişim (HTTPS, bildirim için):** `https://murtaza-vps.tail9e83e1.ts.net/?token=<data/operator-token.txt>` — Tailscale serve (kalıcı, geçerli Let's Encrypt cert). Düz `http://100.88.170.32:8787` de çalışır ama bildirim/okundu API'si HTTPS ister.
- **Panel özellikleri:** ✓/✓✓/✓✓-mavi tikler, okunmamış (bold isim+sayı, açınca sıfırlanır), `~pushName` (rehber adı yoksa), sağ ℹ panelinde "WhatsApp adı", okundu makbuzu per-numara ayarı (cevap-verince/açınca/hiç; varsayılan cevap-verince), bot devreye girme süresi (saniye, ayrı kart, varsayılan 20 — şu an 3), 🔌 bağlantı/QR modalı (panelden kendi kendine pair, restart gerekmez).
- **DB:** `data/poc.sqlite`. ~230 mesaj, 67 sohbet, **432 gerçek rehber adı** + ~54 pushName. Grup mesajları kayıtlı.

## KRİTİK teknik öğrenimler (gelecekte iş kurtarır)

- **Rehber adları:** Baileys'in ilk app-state senkronu `critical_unblock_low` (kayıtlı kişi adları) koleksiyonunu EKSİK çekiyor (~11 ad). Çözüm: bağlantı `open` olunca `sock.resyncAppState(['critical_unblock_low','regular_high','regular_low','regular'], false)` → tümü gelir (11→432). baileys-client.ts'te kalıcı. `Contact.name`=rehber adı, `Contact.notify`=pushName.
- **LID:** WhatsApp v7 aynı kişiyi `@lid` ve telefon JID olarak ayrı gösterir. `key.remoteJidAlt`/`participantAlt` PN karşılığını verir; `@lid` ise PN tercih edilir → tek sohbette birleşir. Mevcut `@lid` kayıtları `data/auth/esmark-test/lid-mapping-<LID>_reverse.json` ile DB migration'la birleştirildi.
- **node v22 + better-sqlite3:** VPS'te Linux x86-64 binary mevcut, node 22 ile çalışıyor.
- **Restart = resume:** Session (`data/auth/esmark-test/`) silinmezse restart +1'i QR'sız resume eder; silinirse yeni QR gerekir.

## Bekleyenler / yarım kalanlar

- **WhatsApp grup → CRM planı:** sadece **Faz 0 (grupta sadece dinleme) BİTTİ.** Faz 1 (grup↔proje eşleme), Faz 2 (Perfex read panelde), Faz 3 (Hermes LLM özet/görev çıkarımı), Faz 4 (Perfex onaylı write) BEKLİYOR. Tam plan: vault `02-Temel/WhatsApp-Grup-CRM-Plani.md`.
- **Kullanıcı doğrulaması bekleyen:** rehber isimlerinin panelde göründüğü (refresh), bekleme-sonrası bot cevabı akışı (3 sn).
- **Açık kararlar (Ersin):** (1) Perfex'e proje/müşteri AÇMA için MySQL-direct (bypass riski) vs Themesic REST API (~$59); (2) `rel_type` 'client' mi 'customer' mı (canlı DESCRIBE ile doğrula); (3) görev otomatik mi onaylı mı.

## Güvenlik notu

- **operator-token** bu oturumda chat'e (panel URL'i) defalarca yapıştırıldı → session jsonl'de duruyor. Tailnet+token korumalı ve rotate edilebilir (`data/operator-token.txt` sil → restart → yeni token). Endişe varsa rotate et.
- Perfex credential'ları (SSH/MySQL) chat'e SIZMADI (sadece anahtar adları konuşuldu).

## Sonraki oturum nereden devam

Plan onaylıysa **Faz 1 (grup↔müşteri/proje eşleme)** ile başla; sonra tek grupla **Faz 3 (Hermes LLM özet/görev)** pilotla. Detay: `02-Temel/WhatsApp-Grup-CRM-Plani.md`. Bot zaten çalışır ve gruplarda sus durumda — gruplara güvenle eklenebilir.
