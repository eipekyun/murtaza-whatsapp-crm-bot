# SESSION_SUMMARY — murtaza-whatsapp-crm-bot

Son güncelleme: 2026-05-29 (akşam oturumu)

## Bu oturumda ne yapıldı (özet)

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
