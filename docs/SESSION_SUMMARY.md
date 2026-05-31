# SESSION_SUMMARY — murtaza-whatsapp-crm-bot

Son güncelleme: 2026-05-31 (Faz 2 — Perfex açık görev/proje paneli; + WhatsApp Durum filtresi)

## 2026-05-31 — Faz 2: Eşli Müşterinin Perfex Açık Görev/Proje Durumu Panelde (read-only)

Plan Faz 2. **Subprocess mimarisi** (mevcut Drive runner kalıbı): `scripts/perfex-query.py` (SSH+MySQL SELECT, rel_type='client' status<5 + tblprojects, clientId int-cast guard, READ-ONLY) → `src/perfex/perfex-reader.ts` (PerfexReader, execFile→JSON, throw etmez) → `GET /api/perfex-tasks?chatId=` → panel sağ panelde **on-demand** "Perfex Görevler" bloğu (SSH latency nedeniyle butona basınca, otomatik değil).

- chatId → perfexClientId çözümü: grup için `chat_crm_mapping` mirror (Faz 1), bireysel/atanmış için `conversation_settings.customerSlug` → müşteri kartı fallback (review fix).
- Perfex'e BAĞLANIR ama **READ-ONLY** (sadece SELECT; INSERT/UPDATE/DELETE yok). Credential `~/.config/murtaza-vps-ops.env` (SSH key + MySQL JSON), script kendi yükler — bot process'inde credential yok.
- **Kalite:** 3-lens adversarial review (16 ajan) → 6 bulgu (LOW/MEDIUM, 0 CRITICAL/HIGH) fix: MySQL hata mesajı sızıntısı (stderr'e log + generic), Python timeout 25→18s (TS 20s altı), bireysel sohbet kart fallback, tip union sadeleştirme, .env belge. tsc temiz, **117 test** (101→117).
- **Canlı doğrulama:** `perfex-query.py 24` → 5 görev + 1 proje. Restart sonrası `/api/perfex-tasks` (atolye-bambini grubu) → 2 proje (Hosting, Dijital Pazarlama) tüm zincir çalıştı; atanmamış sohbet → "firma atanmamış". Commit `8a77cee`. +1 QR'sız resume.

**Sıradaki — Faz 3:** Hermes LLM ile grup mesajlarından özet/aday görev çıkarımı (Codex cascade) → onaylı Perfex write (Faz 4). chat_crm_mapping + Perfex read köprüsü hazır temel.

## 2026-05-31 — WhatsApp Durum (status@broadcast) filtresi

Story paylaşımları normal sohbet listesinden çıkarıldı: `messages.upsert` handler'ında `status@broadcast` drop (kaydedilmez/arşivlenmez/router'a girmez) + `listConversations` defansif filtresi. Commit `902824c`, canlıda aktif.

## 2026-05-31 — Faz 1: Grup ↔ Müşteri/Proje Eşleme (orkestratör + paralel ajan)

Plan: `02-Temel/WhatsApp-Grup-CRM-Plani.md` Faz 1. **Saf Faz 1** (Perfex'e bağlanmaz, vault kartından dosya okur) + **vault authoritative + write-back** (Ersin kararı). Bot CANLI ama yeni kod **henüz restart edilmedi** — değişiklikler working tree'de, commit'li, restart bekliyor.

**Mimari:** Authoritative = vault `02-Temel/WhatsApp-Grup-Eslemesi.md` (satır sonu `<!-- wa-map chat=… slug=… client=… project=… -->`). Bot SQLite `chat_crm_mapping` = mirror. conversation_settings (app_state JSON) = UI/medya state (`customerSlug` + yeni `perfexProjectId`). Panel atama → `onConversationCrmChanged` → card-reader çöz → `setGroupCrmMapping` + vault `upsertGroupMapping` (git YOK, 10dk auto-sync cron commitler). Startup'ta vault okunur, mirror tazelenir (stale temizliği dahil).

**Üretim (orkestratör = Claude Code ana döngü, dalga dalga workflow):**
- YENİ `src/customer/slug.ts` (merkezi normalizeSlug — store + card-reader + media-archiver buna bağlandı), `customer-card-reader.ts` (kart parse: Perfex userid→client, çoklu project ID, lead id, repo path; graceful), `vault-group-mapping.ts` (eşleme dosyası parse + atomik upsert, `@g.us` guard, comment-safe).
- `types.ts`: `ConversationSettings.perfexProjectId` + `ChatCrmMapping`/`CustomerCardInfo`/`ProjectOption`.
- `sqlite-message-store.ts`: `chat_crm_mapping` tablosu + `get/set/list/deleteGroupCrmMapping` (senkron) + perfexProjectId round-trip (0 = temizle → undefined normalize).
- `operator-server.ts`: `listProjects` callback + `GET /api/projects` + `onConversationCrmChanged` + `convProject` select + detayda firma/proje rozeti.
- `index.ts`: listProjects/onConversationCrmChanged/loadGroupMappingsFromVault wiring (grup-only, hata-izole, startup stale cleanup + log).
- Vault: `WhatsApp-Grup-Eslemesi.md` iskelet; 16 aktif müşteri kartı + şablona `## Bilgiler` altında `WhatsApp Grup JID` alanı.

**Kalite:** 4 lens adversarial review (güvenlik/TS/mantık/regresyon, 21 ajan) → 11 onaylı bulgu (LOW/MEDIUM, CRITICAL/HIGH yok) → hepsi düzeltildi: 0-sentinel→undefined normalize, startup stale mirror temizliği (+deleteGroupCrmMapping), 1:1 sohbet chat_crm_mapping'e yazılmıyor (grup-only), writeAtomic tmp cleanup, projectName comment-safe, vault doc chat= hizalama, convProject loadMessages, startup log. **tsc temiz, 101 test yeşil** (57→101).

**Restart + smoke (2026-05-31 ~18:35 UTC — YAPILDI):** Bot SIGTERM→SIGKILL ile durduruldu, setsid ile yeni kodla başlatıldı. +1 **QR'sız resume** etti (`wa-status: {state:open, me:15613764604}`, `handled 0 offline messages`), yeni kod aktif (`Vault grup eşleme yüklendi: 0 entry`), `chat_crm_mapping` tablosu oluştu, YENİ `/api/projects?customerSlug=atolye-bambini` canlı doğrulandı → `[{9,Hosting Hizmeti},{21,Dijital Pazarlama}]`. Yeni process logunda hata yok. ~18 sn downtime, mesaj kaçmadı. Panel `100.88.170.32:8787` (Tailscale).

**Sıradaki — Faz 2:** eşli müşterinin Perfex açık görev/proje durumunu panelde canlı göster (SSH+MySQL read-only). `chat_crm_mapping` mirror artık hazır; Hermes/panel buradan client/project_id okur. Perfex mimari kararı (A=MySQL vs B=REST) Faz 4 write için netleşmeli.

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

## 2026-05-30 (devamı) — Grup sohbeti ayrımı + grup detay paneli

Aynı gün panel testinde kullanıcı grup sorunlarını bildirdi → 3 commit:

- **`ebef9d6` fix — grup içeriği:** `listByChat`'in isim-bazlı sohbet birleştirmesi (LID↔telefon aynı kişiyi tek sohbette toplamak için) gruplara da uygulanıyordu → grupta "Ersin" yazınca Ersin'in **bireysel** sohbeti (53 mesaj) grup görünümüne sızıyordu (grup açınca 4 yerine 57 mesaj). Düzeltme: `@g.us` tam-eşleşme (birleştirme yok); bireysel birleştirme de `@g.us`'u dışlar. + Panel: grup mesajlarında etiket = gerçek gönderen adı (`senderDisplayName`), generic "Müşteri" değil.
- **`3ae591a` fix — sohbet listesi (aynı hatanın 2. yüzü):** `conversations` sorgusu `identity_key`'i gönderen adından üretiyordu → grup "Atölye Bambini"nin `MIN(ad)`='Ersin', Ersin bireysel de 'Ersin' → aynı `identity_key` → birleşip Ersin'in bireysel sohbeti **listeden tamamen siliniyordu** ("Ersin'in mesajları yok"). Düzeltme: gruplar `identity_key` olarak hep kendi `chat_id`'lerini alır.
- **`9df4e02` feat — grup detay paneli:** Grup ℹ → "Grup detayı" + üyeler **telefon + isim + admin** rozetiyle. Veri canlı Baileys `groupMetadata.participants`; eksik isimler DB grup-mesaj gönderen adından. Yeni: `/api/group-info`, `store.getGroupMembersFromMessages`, `index.resolveGroupInfo`.

**KRİTİK öğrenim — isim-bazlı sohbet birleştirme tehlikeli:** `listByChat` + `conversations`'taki "aynı `sender_display_name` = aynı sohbet" mantığı LID↔PN için tasarlanmış ama (a) grupları bireysellerle karıştırıyordu (düzeltildi), (b) tam aynı görünen adlı iki FARKLI bireysel kişiyi de birleştirebilir → **açık risk**. İdeal çözüm: birleştirmeyi isimle değil JID-mapping ile yapmak (gelecek iş).

**Baileys v7 LID tuzağı:** `groupMetadata` participant.id artık `@lid`; **gerçek telefon `Contact.phoneNumber`**, rehber adı `Contact.name`, kişinin kendi adı `Contact.notify`. participant.id'yi telefon sanma (ilk denememde LID numaraları geldi).

56 test. Canlı doğrulama: grup API 57→4, sohbet listesi 68→69 (Ersin geri), grup detay 5 üye gerçek TR numaralarıyla (905322013401 Ersin [admin], 905312153333 Irem [admin]...).

- **`71e8574` feat — grup → firma eşli medya:** Grup bir firmaya atanınca (sağ panel "Firma" select → `customerSlug`) gruptan gelen medya firmanın Drive'ında **`<firma_root>/WhatsApp/Gruplar/<grup adı>/<Tür>/`** altına gider (grup adıyla ayrı). **Whitelist guard genişletildi:** arşivle = gönderen whitelist'te **VEYA** sohbet bir firmaya atanmış → atanmış grubun whitelist DIŞI üyelerinin (Irem vb.) medyası da firma Drive'ına gider (geçen oturumun "açık not"u kapandı). Yeni: `shouldArchiveMedia` callback (baileys→index whitelist|slug), `store.getGroupSubject`, `media-archiver` upload groupName param + `dispatchUpload` grup çözümü, `onCustomerAssigned` dispatchUpload'a sadeleşti, python `cmd_upload --group` + `safe_folder`. 57 test. Python Drive doğrulandı: `Lavanda-Lavander/WhatsApp/Gruplar/Atölye Bambini - Dijital/Belgeler`.

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
