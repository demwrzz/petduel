# TeamFlow — BGL Buy & Sell botu

PetDuel ile hiçbir bağlantısı yok. Kendi başına çalışan bir **ticket (satın alma) botu**.

## Ne yapıyor
- Bir panel atıyorsun: **Buy BGL · Sell BGL · Support** butonları.
- Müşteri butona basınca kendisine özel bir **ticket kanalı** açılıyor (sadece o kişi + yetkililer görüyor).
- Ticket içinde bot ne yazması gerektiğini söylüyor (ne kadar BGL, ödeme yöntemi, GrowID).
- Yetkili **Claim** ile üstleniyor, **Close** ile kapatıyor. Kapatınca konuşmanın kaydı (transcript) log kanalına gidiyor.
- Bot **sahte "ödeme alındı / işlem tamam" mesajı atmaz.** İşlemi yetkili elle onaylar.

## Kurulum (Discord Developer Portal)
1. https://discord.com/developers/applications → **New Application** → bir bot oluştur (PetDuel'den **ayrı** bir uygulama).
2. **Bot** sekmesi → **Reset Token** → token'ı kopyala.
3. **Privileged Gateway Intents** → **Message Content Intent** ve **Server Members Intent** AÇIK olsun.
4. **OAuth2 → URL Generator** → scopes: `bot` → izinler: **Manage Channels, Manage Roles, Read Messages, Send Messages, Manage Messages, Read Message History, Attach Files** → çıkan linkle botu sunucuna ekle.
5. Sunucuda botun rolünü **yetkili/staff rollerinin üstüne** taşı (ticket kanalı açıp kapatabilmesi için).

## Çalıştırma
- `.env.example`'ı `.env` yap, içine `DISCORD_TOKEN=...` yaz (istersen `GUILD_ID=...`).
- Bilgisayarda: klasörde `npm install` sonra `npm start`.
- Railway'de (7/24): yeni servis → bu repo → **Root Directory: `teamflow-bot`** → Variables'a `DISCORD_TOKEN` (ve istersen `GUILD_ID`) → Deploy. Ticket kayıtları kanalda durduğu için volume şart değil.

## config.json
- `brand`, `subtitle`, `currency`, `color` → görünüm.
- `ticketCategoryId` / `logChannelId` / `panelChannelId` → kanal/kategori ID'leri (Discord'da Developer Mode açıp sağ tık → Copy ID). Boşsa `channelNames`'teki isimlerle bulur.
- `staffRoleNames` → yetkili rolleri (bu roller + Manage Channels izni olanlar ticket'ı yönetir).
- `paymentMethods` → panelde ve ticket'ta yazan ödeme yöntemleri.
- `options` → panel butonları (Buy / Sell / Support), istediğini ekleyip çıkarabilirsin.
- `maxOpenTicketsPerUser` → bir kişinin aynı anda açabileceği ticket sayısı.

## Komutlar (prefix `!`)
- **Admin:** `!bglkur` (yedek al + sunucuyu TeamFlow'a çevir)
- **Yetkili:** `!panel` · `!done` · `!rate` · `!close` · `!add @kişi` · `!remove @kişi` · `!help`
- Müşteriler sadece panel butonlarına basar.

## Tamamlanan işlemler (`!done`)
Bir alım/satım **ticket içinde gerçekten bitince**, yetkili şunu yazar:
```
!done buy 5 20 @müşteri usdt
```
= müşteri 5 BGL aldı, 20€, USDT ile.
- `eur` yazmazsan kur × BGL otomatik hesaplanır (`!rate` ile kur: şu an 1 BGL = €4).
- `@müşteri` yazmazsan ticket'ı açan kişi alınır.
- Bot **✅┃completed-deals** kanalına **animasyonlu resimli bir işlem kartı** atar (BGL, €, kur, ödeme kripto logosu, müşteri + yetkili, işlem no). Her kart sadece yetkilinin kaydettiği **gerçek** işlemi gösterir — sahte blockchain/işlem onayı yoktur.
- `!rate 5` → kuru o oturum için 1 BGL = €5 yapar (kalıcı için `config.json` → `rate.bglToEur`).


## Sunucuyu TeamFlow'a çevirme (`!bglkur`)
Sunucuda **yönetici** olarak `!bglkur` yaz:
1. Bot önce **bütün sunucunun yedeğini** alır (kanallar + son 100 mesaj) ve sana **DM** ile JSON dosyası atar.
2. Bir **onay** mesajı çıkar: kaç kanal silineceğini ve nelerin kurulacağını yazar. 2 dakika içinde **"Yes, wipe & set up TeamFlow"** butonuna bas.
3. Bot eski (PetDuel) kanalları siler ve TeamFlow düzenini kurar: `rules`, `prices`, `buy-sell` (panel burada), `tickets` kategorisi, `ticket-logs`. Yedek dosyası `ticket-logs` kanalına da yüklenir.

**Önemli:**
- Bu işlem **geri alınamaz**, ama yedek DM'de ve `ticket-logs`'ta durur (metin olarak).
- `config.json` → `setup.keepChannelNames` içine **silinmesini istemediğin** kanalları yaz (örn. `rules`, `moderator-only`).
- Botun rolü listede **en üstte** ve **Administrator** (ya da en az Manage Channels + Manage Roles) olmalı, yoksa kanalları silemez/kuramaz. Community sunucularda `rules`/`updates` kanalları Discord tarafından korunur, onları elle silersin.

## Dikkat
- BGL gibi oyun parasını gerçek para karşılığı almak/satmak genelde oyunun kurallarına aykırıdır (RMT), sorumluluk sana ait.
- Botu sahte ödeme onayı/escrow taklidi için **kullanma**; o yüzden o özellikler yok.
- Token'ı kimseyle paylaşma, `.env`'yi GitHub'a yükleme.
